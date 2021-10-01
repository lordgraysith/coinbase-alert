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
let status = 'Initializing'
let statusTimeout

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

    status = `\n\nAs of ${new Date().toLocaleString('en-US', {timeZone: 'America/Denver', timeStyle: 'long'})}\n
Portfolio value is $${portfolio}\n
Average account is $${average}
Min account is ${minAccount.curr} at $${minAccount.USD}
Max account is ${maxAccount.curr} at $${maxAccount.USD}`
    console.log(status)
    if(maxAccount.USD - minAccount.USD >= (process.env.DIFF_THRESHOLD || 10)) {
      const sellMessage = `Time to sell ${maxAccount.curr} for ${minAccount.curr}`
      console.log(sellMessage)
      status += `\n\n${sellMessage}\n\n`
      if(!notified) {
        await Bluebird.all(twilioToNumbers.map(recipient => {
          return client.messages 
          .create({ 
              body: sellMessage,  
              messagingServiceSid: process.env.TWILIO_SERVICE_SID,      
              to: recipient
          }) 
          .then(message => {
              notified = true
              statusTimeout = setTimeout(() => {
                notified = false
              }, 60 * 60 * 1000) // nag me every hour
              console.log(message.sid)
          }) 
          .done();
        }))
      }
    } else {
      if (statusTimeout) {
        clearTimeout(statusTimeout)
        statusTimeout = null
      }
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


