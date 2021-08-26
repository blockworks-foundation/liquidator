import * as Env from 'dotenv';
Env.config();
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
  parseTokenAccountData,
  tokenToDecimals,
} from '@blockworks-foundation/mango-client';
import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { homedir } from 'os';
import fs from 'fs';
import { notify, sleep } from './utils';
import { Market, OpenOrders } from '@project-serum/serum';
import {
  makeForceCancelOrdersInstruction,
  makePartialLiquidateInstruction,
} from '@blockworks-foundation/mango-client/lib/instruction';
import BN = require('bn.js');

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
  liqorOpenOrdersKeys: PublicKey[],
  targets: number[],
) {
  // Retrieve orders from order book by owner
  const liqorOrders = await Promise.all(
    markets.map((m) => m.loadOrdersForOwner(connection, liqor.publicKey)),
  );

  // Cancel all
  const cancelTransactions: Promise<string>[] = [];
  for (let i = 0; i < NUM_MARKETS; i++) {
    for (let order of liqorOrders[i]) {
      console.log(
        `Cancelling liqor order on market ${i} size=${order.size} price=${order.price}`,
      );
      cancelTransactions.push(markets[i].cancelOrder(connection, liqor, order));
    }
  }
  await Promise.all(cancelTransactions);

  // Load open orders accounts
  const liqorOpenOrders = await Promise.all(
    liqorOpenOrdersKeys.map((pk) =>
      OpenOrders.load(connection, pk, mangoGroup.dexProgramId),
    ),
  );

  // Settle all
  const settleTransactions: Promise<string>[] = [];
  for (let i = 0; i < NUM_MARKETS; i++) {
    const oo = liqorOpenOrders[i];
    if (
      parseFloat(oo.quoteTokenTotal.toString()) +
        parseFloat(oo['referrerRebatesAccrued'].toString()) >
        0 ||
      parseFloat(oo.baseTokenTotal.toString()) > 0
    ) {
      console.log(
        `Settling funds to liqor wallet ${i} quote:${oo.quoteTokenTotal.toString()} base:${oo.baseTokenTotal.toString()}`,
      );
      settleTransactions.push(
        markets[i].settleFunds(
          connection,
          liqor,
          oo,
          liqorWallets[i],
          liqorWallets[NUM_TOKENS - 1],
        ),
      );
    }
  }
  await Promise.all(settleTransactions);

  // Account wallets should instantly update
  const liqorWalletAccounts = await getMultipleAccounts(
    connection,
    liqorWallets,
    'processed' as Commitment,
  );
  liqorValuesUi = liqorWalletAccounts.map((a, i) =>
    nativeToUi(
      parseTokenAccountData(a.accountInfo.data).amount,
      mangoGroup.mintDecimals[i],
    ),
  );

  const diffs: number[] = [];
  const netValues: [number, number][] = [];
  // Go to each base currency and see if it's above or below target
  for (let i = 0; i < NUM_TOKENS - 1; i++) {
    const diff = liqorValuesUi[i] - targets[i];
    diffs.push(diff);
    netValues.push([i, diff * prices[i]]);
  }

  // Sort in decreasing order so you sell first then buy
  netValues.sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < NUM_TOKENS - 1; i++) {
    const marketIndex = netValues[i][0];
    const market = markets[marketIndex];
    const tokenDecimals = mangoGroup.getTokenDecimals(marketIndex);
    const tokenDecimalAdj = Math.pow(10, tokenDecimals);
    if (netValues[i][1] > 0) {
      // sell to close
      const price = prices[marketIndex] * 0.95;
      const size =
        Math.floor(diffs[marketIndex] * tokenDecimalAdj) / tokenDecimalAdj; // round down the size
      if (size === 0) {
        continue;
      }
      console.log(`Sell to close ${marketIndex} ${size} @ ${price}`);
      let txid = await market.placeOrder(connection, {
        owner: liqor,
        payer: liqorWallets[marketIndex],
        side: 'sell',
        price,
        size,
        orderType: 'ioc',
        openOrdersAddressKey: liqorOpenOrdersKeys[marketIndex],
        feeDiscountPubkey: null, // TODO find liqor's SRM fee account
      });
      // TODO add a SettleFunds instruction to this transaction
      console.log(`Place order successful: ${txid}; Settling funds`);
      await market.settleFunds(
        connection,
        liqor,
        liqorOpenOrders[marketIndex],
        liqorWallets[marketIndex],
        liqorWallets[NUM_TOKENS - 1],
      );
    } else if (netValues[i][1] < 0) {
      // buy to close
      const price = prices[marketIndex] * 1.05; // buy at up to 5% higher than oracle price
      const size =
        Math.ceil(-diffs[marketIndex] * tokenDecimalAdj) / tokenDecimalAdj;

      console.log(`Buy to close ${marketIndex} ${size} @ ${price}`);
      let txid = await market.placeOrder(connection, {
        owner: liqor,
        payer: liqorWallets[NUM_TOKENS - 1],
        side: 'buy',
        price,
        size,
        orderType: 'ioc',
        openOrdersAddressKey: liqorOpenOrdersKeys[marketIndex],
        feeDiscountPubkey: null,
      });
      console.log(`Place order successful: ${txid}; Settling funds`);
      await market.settleFunds(
        connection,
        liqor,
        liqorOpenOrders[marketIndex],
        liqorWallets[marketIndex],
        liqorWallets[NUM_TOKENS - 1],
      );
    }
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

async function runPartialLiquidator() {
  const client = new MangoClient();
  const cluster = process.env.CLUSTER || 'mainnet-beta';
  const group_name = process.env.GROUP_NAME || 'BTC_ETH_SOL_SRM_USDC';
  const clusterUrl = process.env.CLUSTER_URL || IDS.cluster_urls[cluster];
  const targetsStr = process.env.TARGETS || '0.1 2.0 100.0 1000.0';
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || '1000.0');
  const targets = targetsStr.split(' ').map((s) => parseFloat(s));
  const connection = new Connection(clusterUrl, 'singleGossip');

  // The address of the Mango Program on the blockchain
  const programId = new PublicKey(IDS[cluster].mango_program_id);

  // The address of the serum dex program on the blockchain: https://github.com/project-serum/serum-dex
  const dexProgramId = new PublicKey(IDS[cluster].dex_program_id);

  // Address of the MangoGroup
  const mangoGroupPk = new PublicKey(
    IDS[cluster].mango_groups[group_name].mango_group_pk,
  );

  // liquidator's keypair
  const keyPairPath =
    process.env.KEYPAIR || homedir() + '/.config/solana/id.json';
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')));

  notify(`partial liquidator launched cluster=${cluster} group=${group_name}`);

  let mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);

  const tokenWallets = await Promise.all(
    mangoGroup.tokens.map((mint) =>
      findLargestTokenAccountForOwner(connection, payer.publicKey, mint).then(
        (response) => response.publicKey,
      ),
    ),
  );

  // load all markets
  const markets = await Promise.all(
    mangoGroup.spotMarkets.map((pk) =>
      Market.load(
        connection,
        pk,
        { skipPreflight: true, commitment: 'singleGossip' },
        dexProgramId,
      ),
    ),
  );
  // TODO handle failures in any of the steps
  // Find a way to get all margin accounts without querying fresh--get incremental updates to margin accounts
  const liqorOpenOrdersKeys: PublicKey[] = [];

  for (let i = 0; i < NUM_MARKETS; i++) {
    let openOrdersAccounts: OpenOrders[] = await markets[
      i
    ].findOpenOrdersAccountsForOwner(connection, payer.publicKey);
    if (openOrdersAccounts.length) {
      liqorOpenOrdersKeys.push(openOrdersAccounts[0].publicKey);
    } else {
      console.log(
        `No OpenOrders account found for market ${markets[
          i
        ].publicKey.toBase58()}`,
      );
    }
  }

  if (liqorOpenOrdersKeys.length != NUM_MARKETS) {
    console.log(
      'Warning: Missing OpenOrders accounts. Wallet balancing has been disabled.',
    );
  }

  const cancelLimit = 5;
  while (true) {
    try {
      mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
      let marginAccounts = process.env.FILTER_ACCOUNTS
        ? await client.getAllMarginAccountsWithBorrows(
            connection,
            programId,
            mangoGroup,
          )
        : await client.getAllMarginAccounts(connection, programId, mangoGroup);

      shuffleArray(marginAccounts);
      let [prices, vaultAccs, liqorAccs] = await Promise.all([
        mangoGroup.getPrices(connection),
        getMultipleAccounts(connection, mangoGroup.vaults),
        getMultipleAccounts(
          connection,
          tokenWallets,
          'processed' as Commitment,
        ),
      ]);

      const vaultValues = vaultAccs.map((a, i) =>
        nativeToUi(
          parseTokenAccountData(a.accountInfo.data).amount,
          mangoGroup.mintDecimals[i],
        ),
      );
      const liqorTokenValues = liqorAccs.map(
        (a) => parseTokenAccount(a.accountInfo.data).amount,
      );
      const liqorTokenUi = liqorAccs.map((a, i) =>
        nativeToUi(
          parseTokenAccountData(a.accountInfo.data).amount,
          mangoGroup.mintDecimals[i],
        ),
      );

      console.log(prices);
      console.log(vaultValues);
      console.log(liqorTokenUi);

      // FIXME: added bias to collRatio to allow other liquidators to step in for testing
      let coll_bias = 0;
      if (process.env.COLL_BIAS) {
        coll_bias = parseFloat(process.env.COLL_BIAS);
      }

      let maxBorrAcc: MarginAccount | undefined = undefined;
      let maxBorrVal = 0;
      let minCollAcc: MarginAccount | undefined = undefined;
      let minCollVal = 99999;

      for (let ma of marginAccounts) {
        // parallelize this if possible

        let description = '';
        try {
          const assetsVal = ma.getAssetsVal(mangoGroup, prices);
          const liabsVal = ma.getLiabsVal(mangoGroup, prices);
          if (liabsVal > maxBorrVal) {
            maxBorrVal = liabsVal;
            maxBorrAcc = ma;
          }

          if (liabsVal < 0.1) {
            // too small of an account; number precision may cause errors
            continue;
          }
          let collRatio = assetsVal / liabsVal;
          if (collRatio < minCollVal) {
            minCollVal = collRatio;
            minCollAcc = ma;
          }
          if (!ma.beingLiquidated) {
            const deficit = liabsVal * mangoGroup.initCollRatio - assetsVal;
            if (deficit < 0.01) {
              // too small of an account; number precision may cause errors
              continue;
            }

            if (collRatio + coll_bias >= mangoGroup.maintCollRatio) {
              continue;
            }
          }
          description = ma.toPrettyString(mangoGroup, prices);
          console.log(
            `Liquidatable\n${description}\nbeingLiquidated: ${ma.beingLiquidated}`,
          );
          notify(
            `Liquidatable\n${description}\nbeingLiquidated: ${ma.beingLiquidated}`,
          );

          // find the market with the most value in OpenOrdersAccount
          let maxMarketIndex = -1;
          let maxMarketVal = 0;
          for (let i = 0; i < NUM_MARKETS; i++) {
            const openOrdersAccount = ma.openOrdersAccounts[i];
            if (openOrdersAccount === undefined) {
              continue;
            }
            const marketVal =
              openOrdersAccount.quoteTokenTotal.toNumber() +
              openOrdersAccount['referrerRebatesAccrued'].toNumber() +
              openOrdersAccount.baseTokenTotal.toNumber() * prices[i];
            if (marketVal > maxMarketVal) {
              maxMarketIndex = i;
              maxMarketVal = marketVal;
            }
          }

          // Cancel orders on the market with the most value in open orders
          const transaction = new Transaction();
          if (maxMarketIndex !== -1) {
            // force cancel orders on this particular market
            const spotMarket = markets[maxMarketIndex];
            const [bids, asks] = await Promise.all([
              spotMarket.loadBids(connection),
              spotMarket.loadAsks(connection),
            ]);
            const openOrdersAccount = ma.openOrdersAccounts[maxMarketIndex];
            if (openOrdersAccount === undefined) {
              console.log('error state');
              continue;
            }
            let numOrders = spotMarket.filterForOpenOrders(bids, asks, [
              openOrdersAccount,
            ]).length;
            const dexSigner = await PublicKey.createProgramAddress(
              [
                spotMarket.publicKey.toBuffer(),
                spotMarket['_decoded'].vaultSignerNonce.toArrayLike(
                  Buffer,
                  'le',
                  8,
                ),
              ],
              spotMarket.programId,
            );

            for (let i = 0; i < 10; i++) {
              const instruction = makeForceCancelOrdersInstruction(
                programId,
                mangoGroup.publicKey,
                payer.publicKey,
                ma.publicKey,
                mangoGroup.vaults[maxMarketIndex],
                mangoGroup.vaults[NUM_TOKENS - 1],
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
                new BN(cancelLimit),
              );
              transaction.add(instruction);
              numOrders -= cancelLimit;
              if (numOrders <= 0) {
                break;
              }
            }
          }

          // Find the market with the highest borrows and lowest assets
          const deposits = ma.getAssets(mangoGroup);
          const borrows = ma.getLiabs(mangoGroup);
          let minNet = 0;
          let minNetIndex = -1;
          let maxNet = 0;
          let maxNetIndex = NUM_TOKENS - 1;
          for (let i = 0; i < NUM_TOKENS; i++) {
            const netDeposit = (deposits[i] - borrows[i]) * prices[i];
            if (netDeposit < minNet) {
              minNet = netDeposit;
              minNetIndex = i;
            } else if (netDeposit > maxNet) {
              maxNet = netDeposit;
              maxNetIndex = i;
            }
          }

          if (minNetIndex === -1) {
            // In this case, send a random token account that is not maxNetIndex
            minNetIndex = (maxNetIndex + 1) % NUM_TOKENS;
          }

          await client.sendTransaction(connection, transaction, payer, []);

          const liqTx = new Transaction();

          liqTx.add(
            makePartialLiquidateInstruction(
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
              liqorTokenValues[minNetIndex],
            ),
          );

          await client.sendTransaction(connection, liqTx, payer, []);
          await sleep(2000);
          ma = await client.getMarginAccount(
            connection,
            ma.publicKey,
            dexProgramId,
          );
          console.log(
            `Successful partial liquidation\n${ma.toPrettyString(
              mangoGroup,
              prices,
            )}\nbeingLiquidated: ${ma.beingLiquidated}`,
          );
          notify(
            `Successful partial liquidation\n${ma.toPrettyString(
              mangoGroup,
              prices,
            )}\nbeingLiquidated: ${ma.beingLiquidated}`,
          );
          break; // This is so wallets get balanced
        } catch (e) {
          if (!e.timeout) {
            throw e;
          } else {
            notify(`unknown error: ${e}`);
            console.error(e);
          }
        }
      }

      const maxBorrAccPk = maxBorrAcc ? maxBorrAcc.publicKey.toBase58() : '';
      const maxBorrAccCr = maxBorrAcc
        ? maxBorrAcc.getCollateralRatio(mangoGroup, prices)
        : 0;
      const minCollAccPk = minCollAcc ? minCollAcc.publicKey.toBase58() : '';
      const minCollBorrVal = minCollAcc
        ? minCollAcc.getLiabsVal(mangoGroup, prices)
        : 0;

      console.log(
        `Max Borrow Account: ${maxBorrAccPk} | Borrow Val: ${maxBorrVal} | CR: ${maxBorrAccCr}`,
      );
      console.log(
        `Min Coll-Ratio Account: ${minCollAccPk} | Borrow Val: ${minCollBorrVal} | CR: ${minCollVal}`,
      );
      if (liqorOpenOrdersKeys.length == NUM_MARKETS) {
        await balanceWallets(
          connection,
          mangoGroup,
          prices,
          markets,
          payer,
          tokenWallets,
          liqorTokenUi,
          liqorOpenOrdersKeys,
          targets,
        );
      } else {
        console.log(
          'Could not balance wallets due to missing OpenOrders account',
        );
      }
    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(checkInterval);
    }
  }
}

runPartialLiquidator();
