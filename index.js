require('dotenv').config()
const http = require('http')
const ccxt = require('ccxt')
const Bluebird = require('bluebird')
const debugging = process.env.DEBUGGING === 'true'
const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const excludedCurrencies = process.env.EXCLUDED_CURRENCIES.split(':')
const client = require('twilio')(accountSid, authToken)
const twilioToNumbers = process.env.TWILIO_TO_NUMBER.split(';')
const threshold = (process.env.DIFF_THRESHOLD || 10)
let notified = false
let status = {message: 'Initializing', errors:[]}
let statusTimeout


const coinbase = new ccxt.coinbasepro({
    apiKey: process.env.COINBASE_API_KEY,
    secret: process.env.COINBASE_SECRET,
    password: process.env.COINBASE_PASSWORD
})

async function calculate() {
  status.message = 'Calculating'
  status.errors = []
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
            try{
              const c = await coinbase.fetchTicker(`${curr}/USD`)
              return {curr, USD: b.total[curr] * c.last, price: c.last}
            } catch(ex) {
              console.error(ex)
              status.errors.push(ex)
              return {curr, USD: 0}
            }
        }, {
            concurrency: 1
        })
    }())
    const usdAccount = {curr: 'USD', USD: b.total.USD}
    accounts.sort((a, b) => a.USD - b.USD)

    const minAccount = accounts[0]
    const maxAccount = accounts[accounts.length - 1]

    const portfolio = accounts.reduce((prev, curr) => {
        return prev + curr.USD
    }, 0) + usdAccount.USD
    const average = portfolio / accounts.length

    //sell currencies that are more than half the threshold over average
    const toSell = accounts.filter(a => {
      return a.USD > average + (threshold/2)
    })
    for(let i = 0; i < toSell.length; i++) {
      const account = toSell[i]
      const amount = account.USD - average
      console.log(`Selling ${account.curr} for ${amount} USD`)
      try {
        await coinbase.createOrder(`${account.curr}/USD`, 'market', 'sell', amount / account.price)
        usdAccount.USD += amount
      } catch (error) {
        status.errors.push({stack: account.curr + ': ' + error.message})
        status.errors.push(error)
        console.error(error)
      }
    }

    //buy lowest currencies up to average
    for(let i = 0; i < accounts.length && usdAccount.USD > average; i++) {
      const account = accounts[i]
      if(account.USD < average) {
        const amount = average - account.USD
        console.log(`Buying ${account.curr} for ${amount} USD`)
        try {
          await coinbase.createOrder(`${account.curr}/USD`, 'market', 'buy', amount / account.price)
          usdAccount.USD -= amount
        } catch (error) {
          status.errors.push({stack: account.curr + ': ' + error.message})
          status.errors.push(error)
          console.error(error)
        }
      } else {
        break
      }
    }



    
    status.message = `\n\nAs of ${new Date().toLocaleString('en-US', {timeZone: 'America/Denver', timeStyle: 'long'})}\n
Portfolio value is $${portfolio}\n
Average account is $${average}
Min account is ${minAccount.curr} at $${minAccount.USD}
Max account is ${maxAccount.curr} at $${maxAccount.USD}
USD account is $${usdAccount.USD}`
    console.log(status.message)

    if(status.errors.length > 0) {
      
      if(!notified) {
        await Bluebird.all(twilioToNumbers.map(recipient => {
          return client.messages 
          .create({ 
              body: 'Errors exists, see ka.graybeal.xyz/cb for details',  
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
  res.end(`<html><head><title>Coinbase Status</title></head><body>${status.message.replaceAll('\n','<br/>')}<br/>${printErrors(status.errors)}</body></html>`)
})
function printErrors(errors) {
  return errors.map(e => {
    return `<pre>${e.stack}</pre>`
  })
}
server.listen(process.env.PORT)
run()


