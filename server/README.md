# Серверный модуль 1.1.0

Исходники read-only модуля Redmine и скрипты обновления существующей установки 1.0.0.
Клиент MCP устанавливается разработчиками отдельно; эти файлы нужны администратору сервера.
Описание поведения и отката: [README модуля](redmine_completed_work/README.md).

Скрипты предназначены для согласованной установки `/opt/redmine`, проекта `sap-development`
и сервера `redmine.medservice.kz`. Для другой установки сначала адаптируйте пути и адрес проверки HTTPS.
Скрипт обновления требует уже установленный и подключённый модуль; это не установщик Redmine с нуля.

Собрать серверный пакет из этого каталога в Linux:

```sh
tar -czf redmine_completed_work.tar.gz redmine_completed_work
sha256sum redmine_completed_work.tar.gz creation-status-admin.rb upgrade-creation-statuses.sh rollback-creation-statuses.sh > CREATION-STATUS-SHA256SUMS
```

Перенесите архив, три скрипта и манифест в один каталог сервера. Сначала можно выполнить
`sudo bash upgrade-creation-statuses.sh audit`; обновление — `sudo bash upgrade-creation-statuses.sh`.
Не запускайте обновление повторно только ради установки клиентского MCP.

На рабочем сервере обновление уже подтверждено 27.09.2026: аудит, применение и проверка успешно
пройдены для руководителя и разработчиков без административного обхода. Задачи и уведомления не создавались.
