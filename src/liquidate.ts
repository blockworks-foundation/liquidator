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
  parseTokenAccountData, tokenToDecimals,
} from '@blockworks-foundation/mango-client';
import { Account, Connection, PublicKey, TransactionSignature } from '@solana/web3.js';
import fs from 'fs';
import { Market } from '@project-serum/serum';
import { notify, sleep } from './utils';
import { homedir } from 'os';

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

async function runLiquidator() {
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

  while (true) {
    try {
      mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)
      const marginAccounts = await client.getAllMarginAccounts(connection, programId, mangoGroup)
      let prices = await mangoGroup.getPrices(connection)  // TODO put this on websocket as well

      console.log(prices)

      const tokenAccs = await getMultipleAccounts(connection, mangoGroup.vaults)
      const vaultValues = tokenAccs.map(
        (a, i) => nativeToUi(parseTokenAccountData(a.accountInfo.data).amount, mangoGroup.mintDecimals[i])
      )
      console.log(vaultValues)

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

            let collRatio = (assetsVal / liabsVal)

            // FIXME: added bias to collRatio to allow other liquidators to step in for testing
            if (process.env.COLL_BIAS) {
              collRatio += parseFloat(process.env.COLL_BIAS);
            }

            if (collRatio >= mangoGroup.maintCollRatio) {
              break
            }

            const deficit = liabsVal * mangoGroup.initCollRatio - assetsVal
            description = ma.toPrettyString(mangoGroup, prices)

            if (deficit < 0.1) {  // too small of an account; number precision may cause errors
              break
            }
            console.log('liquidatable', deficit)
            console.log(description)

            await client.liquidate(connection, programId, mangoGroup, ma, payer,
              tokenWallets, [0, 0, deficit * 1.01 + 5])
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
        if (liquidated) {
          console.log('liquidation success')
          console.log(ma.toPrettyString(mangoGroup, prices))

          while (true) {
            try {
              ma = await client.getMarginAccount(connection, ma.publicKey, dexProgramId)
              await drainAccount(client, connection, programId, mangoGroup, ma, markets, payer, prices, tokenWallets[NUM_TOKENS-1])
              console.log('Account drain success')
              notify(`liquidated ${description}`)
              break
            } catch (e) {
              notify(`error: ${e}\ncould not liquidate ${description}`)
              await sleep(1000)
            }
          }
        }

      }

      console.log(`Max Borrow Account: ${maxBorrAcc}   |   Max Borrow Val: ${maxBorrVal}`)

    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(sleepTime)
    }
  }
}

runLiquidator()
