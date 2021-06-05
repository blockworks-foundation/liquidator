# Mango Liquidator

## Setup Partial Liquidator
### Prerequisites
To run the liquidator you will need:
* A Solana account with some SOL deposited to cover transaction fees
* Token accounts for each currency in the Mango Group (e.g. BTC, ETH, SOL, SRM, USDT)
* Roughly equal deposits for each token. You will need base currencies to liquidate shorts, and quote currency to liquidate longs.
* Serum Dex OpenOrders accounts associated with your account. This is required for balance wallets functionality.
  * The easiest way to set these up is by placing an order on Serum Dex for each currency pair then immediately cancelling it.
### Setup
Make sure to edit the .env file to look something like this:
```
export CLUSTER="mainnet-beta"
export CLUSTER_URL="https://solana-api.projectserum.com"
export KEYPAIR=~/.config/solana/id.json
export NODE_ENV=production
export TARGETS="0.1 2.0 100.0 500.0"
export GROUP_NAME="BTC_ETH_SOL_SRM_USDT"
export CHECK_INTERVAL="1000.0"
export FILTER_ACCOUNTS=true
```

TARGETS represents the amounts of each token the partial liquidator should try to maintain
in the liquidator's wallet. Any excess of that amount in the wallet will be market sold on Serum DEX.

CHECK_INTERVAL is the amount of milliseconds to wait between querying all margin accounts

FILTER_ACCOUNTS uses a more efficient method of querying marginAccounts by only returning accounts with open borrows. This is only supported on Mango Groups released after 'BTC_ETH_SOL_SRM_USDT'. Disabled by default.

### Run
```
yarn install
source .env
yarn partialLiquidate
```

### Run
```
yarn install
source .env
yarn liquidate
```
