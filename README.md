<img src="public/logo.png" alt="Nestline logo" width="96">

# Nestline

An AI savings agent built on PayPal. Tell it what you are saving for and by when.
It plans across all your goals from one monthly budget, keeps each goal on track,
and pays the merchant through PayPal once a goal is funded and you approve.

Built for the PayPal AI Hackathon ("Build What's Next with PayPal and AI").

## What it does

- **Goals from one message.** "I can save 400 a month. Laptop by March, fees in June, a trip in December."
  The agent turns that into goals with amounts, dates and how fixed each date is.
- **A plan across goals.** Fixed dates are protected first, flexible goals share what is left.
  When everything does not fit, the agent offers a trade-off.
- **Two ways to save.** Top up any goal at any time with PayPal, or accept an optional monthly plan.
- **Rebalancing.** Press "Next month" or "Skip a month" and the plan is recalculated, with the reason logged.
- **Agent pays with approval.** A funded goal raises a payment request. One click sends it through PayPal Payouts.

## How PayPal is used

| Step | PayPal product |
|---|---|
| Top-up into a goal | Orders v2 API (create + capture) with the PayPal JavaScript SDK buttons |
| Agent pays the merchant | Payouts API |

Everything runs on the PayPal **sandbox**. No real money moves.

## How AI is used

Google Gemini (`gemini-3.8-flash` by default, set with `GEMINI_MODEL`) reads the user's message plus the current goals and plan,
and returns a reply with structured actions (add a goal, set the budget, move a deadline, change a target,
set a monthly plan). The allocation maths is ordinary code in `server.js`, so amounts are exact and repeatable.
The model decides what the user means and which trade-off to propose; it never does the arithmetic.

## Run it

Requires Node.js 20.12 or newer. There are no packages to install.

1. Copy `.env.example` to `.env` and fill in:
   - `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a sandbox app at developer.paypal.com
   - `MERCHANT_EMAIL`: the email of a sandbox account that will receive goal payments
   - `GEMINI_API_KEY` from aistudio.google.com
2. Run `npm start`
3. Open http://localhost:3000

To pay in the PayPal window, log in with a sandbox **Personal** account
(developer.paypal.com > Testing Tools > Sandbox Accounts).

## Try this flow

1. Open the dashboard and send: `I can save 400 a month. Laptop by March, my sister's fees in June, a Goa trip in December.`
2. Answer the agent's trade-off question.
3. Add money to a goal with the PayPal button.
4. Click "Set up monthly" on a goal, then "Next month" and "Skip a month" to watch the plan rebalance.
5. Top up a goal until it is funded, then click "Approve and pay with PayPal".

## Notes and limits

- The monthly plan is simulated by the demo clock; it does not charge PayPal on a schedule.
- Top-ups land in the sandbox business account of the app, and payouts are sent from it.
- Data is stored in a local `data.json` file. "Reset demo" clears it.

## License

MIT
