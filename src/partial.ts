import {
  findLargestTokenAccountForOwner,
  getMultipleAccounts,
  IDS,
  MangoClient, nativeToUi, NUM_MARKETS, NUM_TOKENS, parseTokenAccount, parseTokenAccountData, uiToNative,
} from '@blockworks-foundation/mango-client';
import { Account, Connection, PublicKey, Transaction } from '@solana/web3.js';
import { homedir } from 'os';
import fs from 'fs';
import { notify, sleep } from './utils';
import { Market } from '@project-serum/serum';
import {
  makeForceCancelOrdersInstruction,
  makePartialLiquidateInstruction,
} from '@blockworks-foundation/mango-client/lib/instruction';

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

  while (true) {
    try {
      mangoGroup = await client.getMangoGroup(connection, mangoGroupPk)
      // const marginAccounts = await client.getAllMarginAccounts(connection, programId, mangoGroup)
      const marginAccounts = [await client.getMarginAccount(connection, new PublicKey("85zCT5JsSmE5tgF42gPH6xxeVic5tXutAQDkSwfm9FN9"), mangoGroup.dexProgramId)]
      let prices = await mangoGroup.getPrices(connection)  // TODO put this on websocket as well

      console.log(prices)

      const tokenAccs = await getMultipleAccounts(connection, mangoGroup.vaults)
      const vaultValues = tokenAccs.map(
        (a, i) => nativeToUi(parseTokenAccountData(a.accountInfo.data).amount, mangoGroup.mintDecimals[i])
      )
      console.log(vaultValues)

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
              let numInstrs = 0
              while (numInstrs < 10) {
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
                  mangoGroup.oracles
                )
                transaction.add(instruction)
                numOrders -= 6
                numInstrs += 1
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
            // choose the max
            const liqorAccs = await getMultipleAccounts(connection, tokenWallets)
            const liqorTokenValues = liqorAccs.map(
              (a) => parseTokenAccount(a.accountInfo.data).amount
            )

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

            // transaction.recentBlockhash = (await connection.getRecentBlockhash('singleGossip')).blockhash
            // transaction.setSigners(payer.publicKey)
            // transaction.sign(payer)
            // const raw_tx = transaction.serialize()
            // console.log('tx size', raw_tx.length)
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
    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(sleepTime)
    }
  }

}

runPartialLiquidator()