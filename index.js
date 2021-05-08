require('dotenv').config()
const ccxt = require('ccxt')
const Bluebird = require('bluebird')
const debugging = process.env.DEBUGGING
const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const excludedCurrencies = process.env.EXCLUDED_CURRENCIES.split(':')
const client = require('twilio')(accountSid, authToken)
let notified = false

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
    const min = Math.floor(accounts[0].USD)
    const target = (function(){
        let val = min
        let i = 0
        while (i < 5 || val % 5 !== 0) {
            val++
            i++
        }
        return val
    }())

    const portfolio = accounts.reduce((prev, curr) => {
        return prev + curr.USD
    }, 0)

    console.log(`\n\nPortfolio value is $${portfolio}\n`)
    console.log(`Target price is $${target}`)
    const maxAccount = accounts[accounts.length - 1]
    console.log(`Min account is ${accounts[0].curr} at $${accounts[0].USD}`)
    console.log(`Max account is ${maxAccount.curr} at $${maxAccount.USD}`)
    if(maxAccount.USD - target >= 5) {
        console.log('\x1b[5m', `\n\nTime to sell ${maxAccount.curr}\n\n`)
        if(!notified) {
            await client.messages 
                .create({ 
                    body: `Time to sell ${maxAccount.curr} for ${accounts[0].curr}`,  
                    messagingServiceSid: process.env.TWILIO_SERVICE_SID,      
                    to: process.env.TWILIO_TO_NUMBER 
                }) 
                .then(message => {
                    notified = true
                    console.log(message.sid)
                }) 
                .done();
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

run()
