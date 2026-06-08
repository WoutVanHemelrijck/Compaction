
: '

Populate an existing collection with COUNT documents

'
COUNT="$1"


if [ "$COUNT" = "" ]; then
  echo "PROVIDE A COUNT AS ARGUMENT";
  exit 1
fi

for i in `seq 1 $COUNT`; do {
echo " -> $i/$COUNT";
curl -X 'POST' \
  'http://localhost:3000/db/products' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
  "nr": 777
}'

}

done