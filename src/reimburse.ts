import {
  encodeMangoInstruction,
  findLargestTokenAccountForOwner,
  IDS,
  MangoClient,
  uiToNative,
} from '@blockworks-foundation/mango-client';
import {
  Account,
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { homedir } from 'os';
import fs from 'fs';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

async function runReimburse() {
  const client = new MangoClient();
  const cluster = process.env.CLUSTER || 'mainnet-beta';
  const group_name = process.env.GROUP_NAME || 'BTC_ETH_SOL_SRM_USDC';
  const clusterUrl = process.env.CLUSTER_URL || IDS.cluster_urls[cluster];
  const connection = new Connection(clusterUrl, 'singleGossip');

  // The address of the Mango Program on the blockchain
  const programId = new PublicKey(IDS[cluster].mango_program_id);

  // Address of the MangoGroup
  const mangoGroupPk = new PublicKey(
    IDS[cluster].mango_groups[group_name].mango_group_pk,
  );

  // keypair
  const keyPairPath =
    process.env.KEYPAIR || homedir() + '/.config/solana/mm.json';
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')));
  let mangoGroup = await client.getMangoGroup(connection, mangoGroupPk);
  const tokenIndex = 4;
  const tokenAcc = (
    await findLargestTokenAccountForOwner(
      connection,
      payer.publicKey,
      mangoGroup.tokens[tokenIndex],
    )
  ).publicKey;

  const marginAccounts = [
    {
      address: '4iZH4jgK1tdXQ3jwvQE7bsUDmxw1PnkhiBPdgEq5iRoS',
      amount: 1316.310144,
    },
    {
      address: '4WoRSRkvJNenNVk7uB8st9PsjaPY8MZpHtK8NM7pRmzr',
      amount: 405.5065004,
    },
    {
      address: '79k2VqrXFz8vSsuMWtCq2zJX2YGUL3gH5yS2A7gd2WNJ',
      amount: 534.7915884,
    },
    {
      address: '7hudJyNLJKLH14httaFihK3zQ1auF3C1Rex2N79nja9u',
      amount: 1572.512634,
    },
    {
      address: '7PAC5DfMxTYHLZicMrimsdL8XvgTp7gTM6ZbWzArQJXc',
      amount: 2180.24129,
    },
    {
      address: 'CFcm6dtw6xaYkgoxZbRDa6WhLyHvirURT49HZAQGiLX2',
      amount: 3146.680519,
    },
    {
      address: 'GVLZhyZma9tvKiXtKPTeRboju8kzj7MyoY1wPZ93eq79',
      amount: 928.1663967,
    },
    {
      address: 'GvT7iqpnNe1zrXG5G1cNgKDyFYVx3E4Suqx1JmxXZW8m',
      amount: 2421.853979,
    },
    {
      address: 'n3YxMeZvPnMqiNZuecWMdMm7tMszYS2Ve4TnN2bXYPi',
      amount: 2464.867504,
    },
    {
      address: 'x3qpJRZFMHC4SRy2RGnbeahChNEUtd24uFidHMyrkjT',
      amount: 258.1840228,
    },
  ];

  let total = 0;
  for (const ma of marginAccounts) {
    const marginAccount = new PublicKey(ma.address);

    const quantity = ma.amount * 1.2; // fill in quantity
    const nativeQuantity = uiToNative(
      quantity,
      mangoGroup.mintDecimals[tokenIndex],
    );

    const keys = [
      { isSigner: false, isWritable: true, pubkey: mangoGroup.publicKey },
      { isSigner: false, isWritable: true, pubkey: marginAccount },
      { isSigner: true, isWritable: false, pubkey: payer.publicKey },
      { isSigner: false, isWritable: true, pubkey: tokenAcc },
      {
        isSigner: false,
        isWritable: true,
        pubkey: mangoGroup.vaults[tokenIndex],
      },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: SYSVAR_CLOCK_PUBKEY },
    ];
    const data = encodeMangoInstruction({
      Deposit: { quantity: nativeQuantity },
    });

    const instruction = new TransactionInstruction({ keys, data, programId });

    const transaction = new Transaction();
    transaction.add(instruction);
    total += quantity;
    console.log(ma.address.toString(), quantity);
    await client.sendTransaction(connection, transaction, payer, []);
  }

  console.log('total reimbursed', total);
}

runReimburse();
