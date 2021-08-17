require('dotenv').config()
const http = require('http')
const ccxt = require('ccxt')
const Bluebird = require('bluebird')
const debugging = process.env.DEBUGGING
const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const excludedCurrencies = process.env.EXCLUDED_CURRENCIES.split(':')
const client = require('twilio')(accountSid, authToken)
const twilioToNumbers = process.env.TWILIO_TO_NUMBER.split(';')
let notified = false
let status

const coinbase = new ccxt.coinbase({
    apiKey: process.env.COINBASE_API_KEY,
    secret: process.env.COINBASE_SECRET
})

async function calculate() {
    if(debugging) {
        console.log('DEBUGGING')
    }
    const b = await (async function(){
        if (debugging) {
            return require('./balance.js')
        }
        return coinbase.fetchBalance()
    }())
    
    const currencies = Object.keys(b.total).filter(curr => {
        return !excludedCurrencies.includes(curr)
    })
    let count = 0

    const accounts = await (async function(){
        if (debugging) {
            return require('./accounts.js')
        }
        return Bluebird.map(currencies, async curr => {
            // console.log(`Fetching ${curr} - ${++count} out of ${currencies.length}`)
            const c = await coinbase.fetchTicker(`${curr}/USD`)
            await Bluebird.delay(200)
            return {curr, USD: b.total[curr] * c.last}
        }, {
            concurrency: 1
        })
    }())

    accounts.sort((a, b) => a.USD - b.USD)
    const minAccount = accounts[0]
    const maxAccount = accounts[accounts.length - 1]

    const portfolio = accounts.reduce((prev, curr) => {
        return prev + curr.USD
    }, 0)
    const average = portfolio / accounts.length

    status = `\n\nPortfolio value is $${portfolio}\n
Average account is $${average}
Min account is ${minAccount.curr} at $${minAccount.USD}
Max account is ${maxAccount.curr} at $${maxAccount.USD}`
    console.log(status)
    if(maxAccount.USD - minAccount.USD >= 10) {
        console.log('\x1b[5m', `\n\nTime to sell ${maxAccount.curr}\n\n`)
        if(!notified) {
          await Bluebird.all(twilioToNumbers.map(recipient => {
            return client.messages 
            .create({ 
                body: `Time to sell ${maxAccount.curr} for ${minAccount.curr}`,  
                messagingServiceSid: process.env.TWILIO_SERVICE_SID,      
                to: recipient
            }) 
            .then(message => {
                notified = true
                console.log(message.sid)
            }) 
            .done();
          }))
        }
    } else {
        notified = false
    }

}

function run() {
    calculate().catch(ex => {
        console.error(ex)
        process.exit(1)
    }).then(() => {
        setTimeout(run, 1000 * 60 * 5)
    })
}
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<html><head><title>Coinbase Status</title></head><body>${status.replaceAll('\n','<br/>')}</body></html>`)
})
server.listen(process.env.PORT)
run()


