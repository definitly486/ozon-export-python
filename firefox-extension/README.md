# Firefox extension — Ozon Bill auto import

## What it does
Click the extension button while signed in at `https://finance.ozon.ru`. The extension reads the operation history through the same authenticated browser session and sends the JSON directly to the local Flask app at `http://127.0.0.1:8765`. It does not ask for or store your password, cookies, or access tokens.

## Install temporarily in Firefox
1. Start Ozon Bill locally (`./run.sh`), so `127.0.0.1:8765` is available.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose this folder's `manifest.json`.
4. Open `https://finance.ozon.ru/lk` and sign in normally.
5. Click the Ozon Bill extension icon. A Firefox notification reports the result.
6. The app's current date filter is refreshed by reloading the page or changing the date range.

Temporary add-ons are removed when Firefox restarts; load it again. For permanent installation the extension must be packaged and signed by Mozilla.

## Security and limitations
- Only the active `finance.ozon.ru` tab is read after the user clicks the extension button.
- Requests are made from the page's MAIN world with its existing authenticated session.
- The extension sends operation JSON only to the loopback address `127.0.0.1:8765`.
- This relies on Ozon's private web-app endpoint, not a documented public API. Ozon may change it at any time.
- The extension does not automate login, bypass MFA, or run in the background.
