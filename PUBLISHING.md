# Подготовка приватного репозитория

Корень публикуемого проекта — **integrations/redmine-access**, а не вся папка REDMINE.
Соседние каталоги содержат рабочие выгрузки, списки пользователей, серверные скрипты
и архивы; они не нужны для установки MCP. Не публикуйте корневую папку REDMINE целиком.

## Состав

В репозиторий входят `src/`, `test/`, `scripts/configure.ps1`, `examples/`, `server/`,
`package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `.gitattributes`
и документация. `.env`, зависимости и локальные журналы исключены через `.gitignore`.
`server/` содержит только исходники серверного модуля и скрипты его обновления, без выгрузок и секретов.
Флаг `private: true` в package.json защищает от случайной публикации в npm;
приватность GitHub задаётся отдельно при создании репозитория.

## Публикация владельцем

Создайте пустой репозиторий `redmine-mcp` с видимостью **Private** в своём аккаунте
или организации. Не добавляйте автоматически README и другие начальные файлы.
Проверьте видимость до первой отправки кода.

Из папки `integrations/redmine-access` выполните (если Git ещё не инициализирован):

```sh
git init -b main
```

Если на текущем компьютере Git сообщает `detected dubious ownership`, папка создана
другой локальной учётной записью. Для этой проверенной папки можно добавить точечное
исключение (при другом расположении замените путь):

```sh
git config --global --add safe.directory D:/Projects/REDMINE/integrations/redmine-access
```

Добавьте только подготовленные файлы и проверьте состав:

```sh
git add .gitignore .gitattributes .env.example package.json package-lock.json README.md INSTALL.md PUBLISHING.md COMMUNICATION.md COMPLETED-WORK.md src test examples scripts/configure.ps1 server
git diff --cached --stat
git diff --cached
git status --short --ignored
```

Убедитесь, что `.env`, `.redmine-state/` и `node_modules/` отмечены как игнорируемые,
а реальные ключи, выгрузки и рабочие данные отсутствуют в изменениях.
Не используйте `git add -f` для секретных файлов.

После проверки замените OWNER на владельца созданного репозитория:

```sh
git commit -m "Prepare Redmine MCP for private distribution"
git remote add origin git@github.com:OWNER/redmine-mcp.git
git push -u origin main
```

Выдайте доступ выбранным GitHub-аккаунтам разработчиков и отправьте им ссылку
на INSTALL.md в репозитории. Каждый устанавливает зависимости и создаёт свой `.env`.
Готовые архивы из соседнего `dist/` этой подготовкой не проверялись; для распространения
используйте подготовленный репозиторий.

Если секрет когда-либо попал в коммит, удаления файла следующим коммитом недостаточно:
ключ нужно отозвать и заменить, а историю очистить перед распространением.
