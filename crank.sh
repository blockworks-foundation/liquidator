KEYPAIR=$1
source ~/mango/cli/devnet.env $KEYPAIR

DEX_PROGRAM_ID=$(cat $IDS_PATH | jq .devnet.dex_program_id -r)

MARKET_STR="${2^^}/${3^^}"

if [ $MARKET_STR = "BTC/USDT" ]; then
  MARKET=$(cat ~/mango-client-ts/src/ids.json | jq '.devnet.spot_markets|.["BTC/USDT"]' -r)
  BASE_WALLET=$(spl-token accounts --verbose --url $CLUSTER --owner $KEYPAIR $BTC | tail -1 | cut -d' ' -f1)
  QUOTE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $USDT | tail -1 | cut -d' ' -f1)
elif [ $MARKET_STR = "ETH/USDT" ]; then
  MARKET=$(cat ~/mango-client-ts/src/ids.json | jq '.devnet.spot_markets|.["ETH/USDT"]' -r)
  BASE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $ETH | tail -1 | cut -d' ' -f1)
  QUOTE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $USDT | tail -1 | cut -d' ' -f1)
elif [ $MARKET_STR = "BTC/USDC" ]; then
  MARKET=$(cat ~/mango-client-ts/src/ids.json | jq '.devnet.spot_markets|.["BTC/USDC"]' -r)
  BASE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $BTC | tail -1 | cut -d' ' -f1)
  QUOTE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $USDC | tail -1 | cut -d' ' -f1)

elif [ $MARKET_STR = "ETH/USDC" ]; then
  MARKET=$(cat ~/mango-client-ts/src/ids.json | jq '.devnet.spot_markets|.["ETH/USDC"]' -r)
  BASE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $ETH | tail -1 | cut -d' ' -f1)
  QUOTE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $USDC | tail -1 | cut -d' ' -f1)

elif [ $MARKET_STR = "BTC/WUSDT" ]; then
  MARKET=$(cat ~/mango-client-ts/src/ids.json | jq '.devnet.spot_markets|.["BTC/WUSDT"]' -r)

  BASE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $BTC | tail -1 | cut -d' ' -f1)
  QUOTE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $WUSDT | tail -1 | cut -d' ' -f1)
elif [ $MARKET_STR = "ETH/WUSDT" ]; then
  MARKET=$(cat ~/mango-client-ts/src/ids.json | jq '.devnet.spot_markets|.["ETH/WUSDT"]' -r)
  BASE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $ETH | tail -1 | cut -d' ' -f1)
  QUOTE_WALLET=$(spl-token accounts --verbose  --url $CLUSTER --owner $KEYPAIR $WUSDT | tail -1 | cut -d' ' -f1)
else
  echo "invalid args"
fi

pushd ~/blockworks-foundation/serum-dex/dex/crank || exit
cargo run -- $CLUSTER consume-events --dex-program-id $DEX_PROGRAM_ID --payer $KEYPAIR --market $MARKET --coin-wallet $BASE_WALLET --pc-wallet $QUOTE_WALLET --num-workers 1 --events-per-worker 5 --log-directory .
popd