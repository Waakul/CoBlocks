# LiveScratch
[![Install Chrome Extension](https://img.shields.io/badge/Install-Chrome%20Extension-orange?logo=google-chrome)](https://chromewebstore.google.com/detail/livescratch-live-scratch/pfaldlkkohfdnmlcladmhlihpbhlkolm)

Real time collaboration extension for scratch!
- Sign in from the extension popup with [Scratch Auth](https://auth.itinerary.eu.org/documentation/using-scratch-auth). LiveScratch verifies the callback on the backend and stores its own token for later requests.
- 🟢: UPTIME: https://status.uptime-monitor.io/67497373f98a6334aaea672d
- ☕: DONATE: https://ko-fi.com/waakul
# Run locally
- `git clone https://github.com/Waakul/LiveScratch.git`
- cd livescratch/backend
- `npm install`
- Create the env file based on .env.example.
- Set `PUBLIC_BASE_URL` to the public URL of your backend so Scratch Auth can return to it. The default is the hosted LiveScratch API.
- `npm run start` (This will create a pm2 process & start it).
- Additionally, `npm run stop` to stop the backend process & `npm run delete` to delete the pm2 process.
- Now go ahead and set Custom server (in the popup) to `http://localhost:<PORT>`
- Now load the extension from chrome or any other chomium-based browsers and voila! You have ran livescratch locally.
# Contribute
Your free to go ahead and create a pull request for your work! It may be merged and you'll be credited!
# Credits:
- [@Waakul](https://github.com/Waakul) (Owner, Maintainer, Developer)
- The original code this was developed from is made by [@MeechaPooch](https://github.com/meechapooch) and [@rgantzos](https://github.com/rgantzos) from [Blocklive](https://github.com/BlockliveScratch/Blocklive)
