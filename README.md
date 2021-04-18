# Mango Liquidator

## Setup Partial Liquidator
Make sure to edit the .env file to look something like this:
```
export CLUSTER="mainnet-beta"
export CLUSTER_URL="https://solana-api.projectserum.com"
export KEYPAIR=~/.config/solana/id.json
export NODE_ENV=production
export TARGETS="0.1 2"
export GROUP_NAME="BTC_ETH_USDT"
export CHECK_INTERVAL="1000.0"
```

TARGETS represents the BTC and ETH amounts the partial liquidator should try to maintain
in the liquidator's wallet. Any excess of that amount in the wallet will be market sold on Serum DEX.

CHECK_INTERVAL is the amount of milliseconds to wait between querying all margin accounts

### Run
```
yarn install
source .env
yarn partialLiquidate
```

## Setup Full Liquidator [DEPRECATED]
Make sure to edit the .env file to look something like this:
```
export CLUSTER="mainnet-beta"
export CLUSTER_URL="https://solana-api.projectserum.com"
export KEYPAIR=~/.config/solana/id.json
export NODE_ENV=production
export GROUP_NAME="BTC_ETH_USDT"
```

### Run
```
yarn install
source .env
yarn liquidate
```
