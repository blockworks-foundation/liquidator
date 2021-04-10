# Mango Liquidator

## Setup Full Liquidator
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


## Setup Partial Liquidator
Make sure to edit the .env file to look something like this:
```
export CLUSTER="mainnet-beta"
export CLUSTER_URL="https://solana-api.projectserum.com"
export KEYPAIR=~/.config/solana/id.json
export NODE_ENV=production
export TARGETS="0.1 2"
export GROUP_NAME="BTC_ETH_USDT"
```

TARGETS represents the BTC and ETH amounts the partial liquidator should try to maintain
in the liquidator's wallet

### Run
```
yarn install
source .env
yarn partialLiquidate
```