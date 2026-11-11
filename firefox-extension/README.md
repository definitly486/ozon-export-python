# Firefox extension — Ozon Bill auto import

## What it does
Click the extension button while signed in at `https://finance.ozon.ru`. The extension reads the operation history through the same authenticated browser session and sends the JSON directly to the local Flask app at `http://127.0.0.1:8765`. It does not ask for or store your password, cookies, or access tokens.

## Install temporarily in Firefox
1. Start Ozon Bill locally (`./run.sh`), so `127.0.0.1:8765` is available.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose this folder's `manifest.json`.
4. Open `https://finance.ozon.ru/lk` and sign in normally.
5. Click the Ozon Bill extension icon. Firefox notifications and a badge on the extension icon show each stage: fetching from Ozon, saving to the database, and the final result. The badge changes to `...` while working, `OK` on success, and `!` on error. If desktop notifications are disabled, the badge and extension tooltip still show the status.
6. On success, the final notification shows how many operations were received, added, updated, unchanged, skipped (if any), and the total number stored in the database. If nothing new was added, it explicitly says the data is already up to date.
7. On failure, the notification shows the error reason. Check that Ozon Bill is running and that Firefox is signed in to the correct Ozon Bank account.
8. The app's current date filter is refreshed by reloading the page or changing the date range.

Temporary add-ons are removed when Firefox restarts; load it again. For permanent installation the extension must be packaged and signed by Mozilla.

## Security and limitations
- Only the active `finance.ozon.ru` tab is read after the user clicks the extension button.
- Requests are made from the page's MAIN world with its existing authenticated session.
- The extension sends operation JSON only to the loopback address `127.0.0.1:8765`.
- This relies on Ozon's private web-app endpoint, not a documented public API. Ozon may change it at any time.
- The extension does not automate login, bypass MFA, or run in the background.


### Если расширение сообщает, что Ozon Bill недоступен

1. Запустите приложение из каталога проекта командой `./run.sh` и оставьте терминал открытым.
2. Откройте в Firefox адрес `http://127.0.0.1:8765/api/health`. Должен отобразиться JSON с `"ok": true`.
3. Откройте `about:debugging#/runtime/this-firefox`, найдите Ozon Bill и нажмите «Перезагрузить».
4. Повторите импорт из вкладки Ozon Банка.

Новая версия расширения проверяет локальный сервер отдельно от передачи выписки. Для отправки JSON используется `text/plain`, чтобы избежать предварительного CORS-запроса `OPTIONS` в Firefox.
