# Firefox extension — Ozon Bill auto import

## What it does
Click the extension button from any tab. The extension opens `https://finance.ozon.ru/lk` in a temporary background tab without switching the active page, uses the existing Firefox login session to read operation history, sends JSON to the local Flask app at `http://127.0.0.1:8765`, and closes the temporary tab. If the Ozon session has expired and interactive login is required, the extension does not bring the bank tab to the foreground; sign in in a normal Firefox tab and retry. You do not need to keep the bank page open. It does not ask for or store your password, cookies, or access tokens.

## Install temporarily in Firefox
1. Start Ozon Bill locally (`./run.sh`), so `127.0.0.1:8765` is available.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose this folder's `manifest.json`.
4. Open `https://finance.ozon.ru/lk` and sign in normally.
5. Click the Ozon Bill extension icon from any tab. The extension will open the bank in a background tab automatically; you do not need to open it yourself. Firefox notifications and a badge on the extension icon show each stage: fetching from Ozon, saving to the database, and the final result. The badge changes to `...` while working, `OK` on success, and `!` on error. If desktop notifications are disabled, the badge and extension tooltip still show the status.
6. On success, the final notification shows how many operations were received, added, updated, unchanged, skipped (if any), and the total number stored in the database. If nothing new was added, it explicitly says the data is already up to date.
7. On failure, the notification shows the error reason. Check that Ozon Bill is running and that Firefox is signed in to the correct Ozon Bank account.
8. The app's current date filter is refreshed by reloading the page or changing the date range.

Temporary add-ons are removed when Firefox restarts; load it again. For permanent installation the extension must be packaged and signed by Mozilla.

## Security and limitations
- A temporary inactive `finance.ozon.ru` tab is opened only after the user clicks the extension button, then closed after the import.
- Requests are made from the page's MAIN world with the existing Firefox authenticated session. If the Ozon session has expired, sign in to Ozon again and retry.
- The extension sends operation JSON only to the loopback address `127.0.0.1:8765`.
- This relies on Ozon's private web-app endpoint, not a documented public API. Ozon may change it at any time.
- The extension does not automate login or bypass MFA. The data request is performed in a temporary background tab, not by silently bypassing the bank's login.


### Если расширение сообщает, что Ozon Bill недоступен

1. Запустите приложение из каталога проекта командой `./run.sh` и оставьте терминал открытым.
2. Откройте в Firefox адрес `http://127.0.0.1:8765/api/health`. Должен отобразиться JSON с `"ok": true`.
3. Откройте `about:debugging#/runtime/this-firefox`, найдите Ozon Bill и нажмите «Перезагрузить».
4. Повторите импорт из вкладки Ozon Банка.

Новая версия расширения проверяет локальный сервер отдельно от передачи выписки. Для отправки JSON используется `text/plain`, чтобы избежать предварительного CORS-запроса `OPTIONS` в Firefox.


### Исправление CORS и уведомлений Firefox

Если в консоли есть `CORS Missing Allow Origin` для `127.0.0.1:8765`, обновите приложение из этой ветки и перезапустите `./run.sh`. Локальный Flask API теперь возвращает CORS-заголовки для запросов расширения. Также исправлено использование API уведомлений: Firefox не поддерживает `browser.notifications.update()`, поэтому расширение повторно создаёт уведомление с тем же идентификатором.


### Import without manually opening Ozon Bank

The extension now works from any Firefox tab. On click it creates a temporary inactive tab at `https://finance.ozon.ru/lk`, waits for the page to load, retrieves operations using the existing signed-in Firefox session, and closes that tab. If Ozon asks you to sign in or complete MFA, the extension brings the temporary tab to the foreground and waits up to three minutes for the return to `finance.ozon.ru`. The extension now has host access to Ozon login subdomains so Firefox can report the redirect URL reliably. After updating, reload the add-on in `about:debugging` and approve any new host-access prompt. The local Ozon Bill app must still be running at `127.0.0.1:8765`.


### Automatic dashboard refresh after import

If Ozon Bill is already open in a browser tab, it checks the local database status every 3 seconds. When the Firefox extension finishes an import and the database sync timestamp changes (including the first sync after the page was opened), or the row count changes, the currently selected date range is reloaded automatically. No manual page refresh is needed. Polling pauses while the dashboard tab is hidden and resumes when it becomes visible.

### Автозаполнение постоянного PIN-кода

Откройте настройки расширения в `about:addons` → **Ozon Bill — автоматическая выгрузка** → **Настройки**. Один раз введите постоянный четырёхзначный PIN и сохраните его. Расширение хранит PIN в `browser.storage.local` профиля Firefox и автоматически заполняет четыре отдельных однозначных поля на странице Ozon Банка. Оно не нажимает кнопку подтверждения.

**Предупреждение:** PIN хранится локально без шифрования. Не включайте функцию на общем или недоверенном компьютере и защитите профиль Firefox и учётную запись ОС. Если PIN изменится, сохраните новый в настройках расширения. Чтобы удалить сохранённый PIN, очистите данные расширения в настройках Firefox.
