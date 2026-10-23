name: Sticker Cutter Bot

on:
workflow_dispatch:
push:
branches:
- main

jobs:
run-bot:
runs-on: ubuntu-latest
timeout-minutes: 350

steps:  
  - name: Get code  
    uses: actions/checkout@v4  

  - name: Set up Node.js  
    uses: actions/setup-node@v4  
    with:  
      node-version: 20  

  - name: Install dependencies  
    run: npm install  

  - name: Start bot  
    run: npm start  
    env:  
      BOT_TOKEN: ${{ secrets.BOT_TOKEN }}  
      REMOVE_BG_API_KEY: ${{ secrets.REMOVE_BG_API_KEY }}