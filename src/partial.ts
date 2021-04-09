import {
  findLargestTokenAccountForOwner,
  getMultipleAccounts,
  IDS,
  MangoClient,
  MangoGroup,
  MarginAccount,
  nativeToUi,
  NUM_MARKETS,
  NUM_TOKENS,
  parseTokenAccount,
  parseTokenAccountData, tokenToDecimals,
  uiToNative,
} from '@blockworks-foundation/mango-client';
import { Account, Connection, PublicKey, Transaction, TransactionSignature } from '@solana/web3.js';
import { homedir } from 'os';
import fs from 'fs';
import { notify, sleep } from './utils';
import { Market, OpenOrders } from '@project-serum/serum';
import {
  makeForceCancelOrdersInstruction,
  makePartialLiquidateInstruction,
} from '@blockworks-foundation/mango-client/lib/instruction';
import BN = require('bn.js');


async function drainAccount(
  client: MangoClient,
  connection: Connection,
  programId: PublicKey,
  mangoGroup: MangoGroup,
  ma: MarginAccount,
  markets: Market[],
  payer: Account,
  prices: number[],
  usdWallet: PublicKey
) {
  // Cancel all open orders
  const bidsPromises = markets.map((market) => market.loadBids(connection))
  const asksPromises = markets.map((market) => market.loadAsks(connection))
  const books = await Promise.all(bidsPromises.concat(asksPromises))
  const bids = books.slice(0, books.length / 2)
  const asks = books.slice(books.length / 2, books.length)

  const cancelProms: Promise<TransactionSignature[]>[] = []
  for (let i = 0; i < NUM_MARKETS; i++) {
    cancelProms.push(ma.cancelAllOrdersByMarket(connection, client, programId, mangoGroup, markets[i], bids[i], asks[i], payer))
  }

  await Promise.all(cancelProms)
  console.log('all orders cancelled')

  ma = await client.getMarginAccount(connection, ma.publicKey, mangoGroup.dexProgramId)
  await client.settleAll(connection, programId, mangoGroup, ma, markets, payer)
  console.log('settleAll complete')
  await sleep(2000)
  ma = await client.getMarginAccount(connection, ma.publicKey, mangoGroup.dexProgramId)

  // sort non-quote currency assets by value
  const assets = ma.getAssets(mangoGroup)
  const liabs = ma.getLiabs(mangoGroup)

  const netValues: [number, number][] = []

  for (let i = 0; i < NUM_TOKENS - 1; i++) {
    netValues.push([i, (assets[i] - liabs[i]) * prices[i]])
  }

  // Sort by those with largest net deposits and sell those first before trying to buy back the borrowed
  netValues.sort((a, b) => (b[1] - a[1]))

  for (let i = 0; i < NUM_TOKENS - 1; i++) {
    const marketIndex = netValues[i][0]
    const market = markets[marketIndex]
    const tokenDecimals = tokenToDecimals[marketIndex === 0 ? 'BTC' : 'ETH']
    const tokenDecimalAdj = Math.pow(10, tokenDecimals)

    if (netValues[i][1] > 0) { // sell to close
      const price = prices[marketIndex] * 0.95
      const size = Math.floor(assets[marketIndex] * tokenDecimalAdj) / tokenDecimalAdj  // round down the size
      if (size === 0) {
        continue
      }
      console.log(`Sell to close ${marketIndex} ${size}`)
      await client.placeOrder(connection, programId, mangoGroup, ma, market, payer, 'sell', price, size, 'limit')

    } else if (netValues[i][1] < 0) { // buy to close
      const price = prices[marketIndex] * 1.05  // buy at up to 5% higher than oracle price
      const size = Math.ceil(liabs[marketIndex] * tokenDecimalAdj) / tokenDecimalAdj

      console.log(`Buy to close ${marketIndex} ${size}`)
      await client.placeOrder(connection, programId, mangoGroup, ma, market, payer, 'buy', price, size, 'limit')
    }
  }

  await sleep(3000)
  ma = await client.getMarginAccount(connection, ma.publicKey, mangoGroup.dexProgramId)
  await client.settleAll(connection, programId, mangoGroup, ma, markets, payer)
  console.log('settleAll complete')
  ma = await client.getMarginAccount(connection, ma.publicKey, mangoGroup.dexProgramId)
  console.log('Liquidation process complete\n', ma.toPrettyString(mangoGroup, prices))

  console.log('Withdrawing USD')

  await client.withdraw(connection, programId, mangoGroup, ma, payer, mangoGroup.tokens[NUM_TOKENS-1], usdWallet, ma.getUiDeposit(mangoGroup, NUM_TOKENS-1) * 0.999)
  console.log('Successfully drained account', ma.publicKey.toString())
}

/*
  After a liquidation, the amounts in each wallet become unbalanced
  Make sure to sell or buy quantities different from the target on base currencies
  Convert excess into quote currency
 */
async function balanceWallets(
  connection: Connection,
  mangoGroup: MangoGroup,
  prices: number[],
  markets: Market[],
  liqor: Account,
  liqorWallets: PublicKey[],
  liqorValuesUi: number[],
  liqorOpenOrdersKeys: PublicKey[]
) {
  const liqorOpenOrders = await Promise.all(liqorOpenOrdersKeys.map((pk) => OpenOrders.load(connection, pk, mangoGroup.dexProgramId)))
  let updateWallets = false
  for (let i = 0; i < NUM_MARKETS; i++) {
    const oo = liqorOpenOrders[i]
    if (parseFloat(oo.quoteTokenTotal.toString()) > 0 || parseFloat(oo.baseTokenTotal.toString()) > 0) {
      console.log(`Settling funds on liqor wallet ${i}`)
      await markets[i].settleFunds(connection, liqor, oo, liqorWallets[i], liqorWallets[NUM_TOKENS-1])
      updateWallets = true
    }
  }

  if (updateWallets) {
    await sleep(1000)
    const liqorWalletAccounts = await getMultipleAccounts(connection, liqorWallets)
    liqorValuesUi = liqorWalletAccounts.map(
      (a, i) => nativeToUi(parseTokenAccountData(a.accountInfo.data).amount, mangoGroup.mintDecimals[i])
    )
  }

  // TODO cancel outstanding orders as well
  const targets = [0.1, 2]
  const diffs: number[] = []
  const netValues: [number, number][] = []
  // Go to each base currency and see if it's above or below target
  for (let i = 0; i < NUM_TOKENS - 1; i++) {
    const diff = liqorValuesUi[i] - targets[i]
    diffs.push(diff)
    netValues.push([i, diff * prices[i]])
  }

  // Sort in decreasing order so you sell first then buy
  netValues.sort((a, b) => (b[1] - a[1]))
  for (let i = 0; i < NUM_TOKENS - 1; i++) {
    const marketIndex = netValues[i][0]
    const market = markets[marketIndex]
    const tokenDecimals = tokenToDecimals[marketIndex === 0 ? 'BTC' : 'ETH']  // TODO make this mapping allow arbitrary mango groups
    // const tokenDecimalAdj = Math.pow(10, tokenDecimals)
    const tokenDecimalAdj = Math.pow(10, 3)

    if (netValues[i][1] > 0) { // sell to close
      const price = prices[marketIndex] * 0.95
      const size = Math.floor(diffs[marketIndex] * tokenDecimalAdj) / tokenDecimalAdj  // round down the size
      if (size === 0) {
        continue
      }
      console.log(`Sell to close ${marketIndex} ${size} @ ${price}`)
      let txid = await market.placeOrder(
        connection,
        {
          owner: liqor,
          payer: liqorWallets[marketIndex],
          side: 'sell',
          price,
          size,
          orderType: 'ioc',
          openOrdersAddressKey: liqorOpenOrdersKeys[marketIndex],
          feeDiscountPubkey: null
        }
      )
      console.log("settling funds")
      await market.settleFunds(connection, liqor, liqorOpenOrders[marketIndex], liqorWallets[marketIndex], liqorWallets[NUM_TOKENS-1])

    } else if (netValues[i][1] < 0) { // buy to close
      const price = prices[marketIndex] * 1.05  // buy at up to 5% higher than oracle price
      const size = Math.ceil(-diffs[marketIndex] * tokenDecimalAdj) / tokenDecimalAdj

      console.log(`Buy to close ${marketIndex} ${size} @ ${price}`)
      let txid = await market.placeOrder(
        connection,
        {
          owner: liqor,
          payer: liqorWallets[NUM_TOKENS-1],
          side: 'buy',
          price,
          size,
          orderType: 'ioc',
          openOrdersAddressKey: liqorOpenOrdersKeys[marketIndex],
          feeDiscountPubkey: null
        }
      )
      console.log("settling funds")
      await market.settleFunds(connection, liqor, liqorOpenOrders[marketIndex], liqorWallets[marketIndex], liqorWallets[NUM_TOKENS-1])
    }
  }
}

async function runPartialLiquidator() {
  const client = new MangoClient()
  const cluster = process.env.CLUSTER || 'mainnet-beta'
  const group_name = process.env.GROUP_NAME || 'BTC_ETH_USDT'
  const clusterUrl = process.env.CLUSTER_URL || IDS.cluster_urls[cluster]
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Mango Program on the blockchain
  const programId = new PublicKey(IDS[cluster].mango_program_id)

  // The address of the serum dex program on the blockchain: https://github.com/project-serum/serum-dex
  const dexProgramId = new PublicKey(IDS[cluster].dex_program_id)

  // Address of the MangoGroup
  const mangoGroupPk = new PublicKey(IDS[cluster].mango_groups[group_name].mango_group_pk)

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  notify(`liquidator launched cluster=${cluster} group=${group_name}`);

  let mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)

  const tokenWallets = (await Promise.all(
    mangoGroup.tokens.map(
      (mint) => findLargestTokenAccountForOwner(connection, payer.publicKey, mint).then(
        (response) => response.publicKey
      )
    )
  ))

  // load all markets
  const markets = await Promise.all(mangoGroup.spotMarkets.map(
    (pk) => Market.load(connection, pk, {skipPreflight: true, commitment: 'singleGossip'}, dexProgramId)
  ))
  const sleepTime = 5000
  // TODO handle failures in any of the steps
  // Find a way to get all margin accounts without querying fresh--get incremental updates to margin accounts

  const liqorOpenOrdersKeys: PublicKey[] = []

  for (let i = 0; i < NUM_MARKETS; i++) {
    let openOrdersAccounts: OpenOrders[] = await markets[i].findOpenOrdersAccountsForOwner(connection, payer.publicKey)
    liqorOpenOrdersKeys.push(openOrdersAccounts[0].publicKey)
  }

  const cancelLimit = 5
  while (true) {
    try {
      mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)
      // const marginAccounts = await client.getAllMarginAccounts(connection, programId, mangoGroup)
      // const marginAccounts = [await client.getMarginAccount(connection, new PublicKey("85zCT5JsSmE5tgF42gPH6xxeVic5tXutAQDkSwfm9FN9"), mangoGroup.dexProgramId)]
      // let prices = await mangoGroup.getPrices(connection)  // TODO put this on websocket as well

      let [marginAccounts, prices, vaultAccs, liqorAccs] = await Promise.all([
        client.getAllMarginAccounts(connection, programId, mangoGroup),
        mangoGroup.getPrices(connection),
        getMultipleAccounts(connection, mangoGroup.vaults),
        getMultipleAccounts(connection, tokenWallets),
      ])

      const vaultValues = vaultAccs.map(
        (a, i) => nativeToUi(parseTokenAccountData(a.accountInfo.data).amount, mangoGroup.mintDecimals[i])
      )
      const liqorTokenValues = liqorAccs.map(
        (a) => parseTokenAccount(a.accountInfo.data).amount
      )
      const liqorTokenUi = liqorAccs.map(
        (a, i) => nativeToUi(parseTokenAccountData(a.accountInfo.data).amount, mangoGroup.mintDecimals[i])
      )

      console.log(vaultValues)
      console.log(liqorTokenUi)

      // FIXME: added bias to collRatio to allow other liquidators to step in for testing
      let coll_bias = 0
      if (process.env.COLL_BIAS) {
        coll_bias = parseFloat(process.env.COLL_BIAS)
      }

      let maxBorrAcc = ""
      let maxBorrVal = 0;
      for (let ma of marginAccounts) {  // parallelize this if possible

        let liquidated = false
        let description = ''
        while (true) {
          try {
            const assetsVal = ma.getAssetsVal(mangoGroup, prices)
            const liabsVal = ma.getLiabsVal(mangoGroup, prices)
            if (liabsVal > maxBorrVal) {
              maxBorrVal = liabsVal
              maxBorrAcc = ma.publicKey.toBase58()
            }

            if (liabsVal < 0.1) {  // too small of an account; number precision may cause errors
              break
            }

            if (!ma.beingLiquidated) {
              let collRatio = (assetsVal / liabsVal)
              if (collRatio + coll_bias >= mangoGroup.maintCollRatio) {
                break
              }

              const deficit = liabsVal * mangoGroup.initCollRatio - assetsVal
              if (deficit < 0.1) {  // too small of an account; number precision may cause errors
                break
              }
            }

            description = ma.toPrettyString(mangoGroup, prices)
            console.log('liquidatable')
            console.log(description)

            // find the market with the most value in OpenOrdersAccount
            let maxMarketIndex = -1
            let maxMarketVal = 0
            for (let i = 0; i < NUM_MARKETS; i++) {
              const openOrdersAccount = ma.openOrdersAccounts[i]
              if (openOrdersAccount === undefined) {
                continue
              }
              const marketVal = openOrdersAccount.quoteTokenTotal.toNumber() + openOrdersAccount.baseTokenTotal.toNumber() * prices[i]
              if (marketVal > maxMarketVal) {
                maxMarketIndex = i
                maxMarketVal = marketVal
              }
            }
            const transaction = new Transaction()
            if (maxMarketIndex !== -1) {
              // force cancel orders on this particular market
              const spotMarket = markets[maxMarketIndex]
              const [bids, asks] = await Promise.all([spotMarket.loadBids(connection), spotMarket.loadAsks(connection)])
              const openOrdersAccount = ma.openOrdersAccounts[maxMarketIndex]
              if (openOrdersAccount === undefined) {
                console.log('error state')
                continue
              }
              let numOrders = spotMarket.filterForOpenOrders(bids, asks, [openOrdersAccount]).length
              const dexSigner = await PublicKey.createProgramAddress(
                [
                  spotMarket.publicKey.toBuffer(),
                  spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
                ],
                spotMarket.programId
              )

              for (let i = 0; i < 10; i++) {
                const instruction = makeForceCancelOrdersInstruction(
                  programId,
                  mangoGroup.publicKey,
                  payer.publicKey,
                  ma.publicKey,
                  mangoGroup.vaults[maxMarketIndex],
                  mangoGroup.vaults[NUM_TOKENS-1],
                  spotMarket.publicKey,
                  spotMarket.bidsAddress,
                  spotMarket.asksAddress,
                  mangoGroup.signerKey,
                  spotMarket['_decoded'].eventQueue,
                  spotMarket['_decoded'].baseVault,
                  spotMarket['_decoded'].quoteVault,
                  dexSigner,
                  spotMarket.programId,
                  ma.openOrders,
                  mangoGroup.oracles,
                  new BN(cancelLimit)
                )
                transaction.add(instruction)
                numOrders -= cancelLimit
                if (numOrders <= 0) {
                  break
                }
              }
            }

            // I'm assuming here that there is at least one asset greater than 0 and one less than
            // In reality, assets may be exactly 0
            const deposits = ma.getAssets(mangoGroup)
            const borrows = ma.getLiabs(mangoGroup)
            let minNet = 0
            let minNetIndex = -1
            let maxNet = 0
            let maxNetIndex = NUM_TOKENS-1
            for (let i = 0; i < NUM_TOKENS; i++) {
              const netDeposit = (deposits[i] - borrows[i]) * prices[i]
              if (netDeposit < minNet) {
                minNet = netDeposit
                minNetIndex = i
              } else if (netDeposit > maxNet) {
                maxNet = netDeposit
                maxNetIndex = i
              }
            }

            transaction.add(makePartialLiquidateInstruction(
              programId,
              mangoGroup.publicKey,
              payer.publicKey,
              liqorAccs[minNetIndex].publicKey,
              liqorAccs[maxNetIndex].publicKey,
              ma.publicKey,
              mangoGroup.vaults[minNetIndex],
              mangoGroup.vaults[maxNetIndex],
              mangoGroup.signerKey,
              ma.openOrders,
              mangoGroup.oracles,
              liqorTokenValues[minNetIndex]
            ))

            await client.sendTransaction(connection, transaction, payer, [])
            console.log('success liquidation')
            liquidated = true
            break
          } catch (e) {
            if (!e.timeout) {
              throw e
            } else {
              await sleep(1000)
              prices = await mangoGroup.getPrices(connection)
              ma = await client.getMarginAccount(connection, ma.publicKey, dexProgramId)
            }
          }
        }
      }
      console.log(`Max Borrow Account: ${maxBorrAcc}   |   Max Borrow Val: ${maxBorrVal}`)

      await balanceWallets(connection, mangoGroup, prices, markets, payer, tokenWallets, liqorTokenUi, liqorOpenOrdersKeys)

    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(sleepTime)
    }
  }

}

runPartialLiquidator()