# 首个管理员初始化

本地显式执行一次性命令，不开放注册或初始化 HTTP 接口。脚本只写入团队、首个管理员和一条 `member.bootstrapped` 审计，不创建 Session、平台授权或配置版本。初始化仅写入账号；网页登录依赖已启动的认证服务和前端，见[认证说明](auth.md)。

在项目根目录配置业务 `DATABASE_URL`，确认迁移已经应用、运行身份为非超级用户且没有创建数据库和角色的权限。然后运行：

```sh
npm run admin:bootstrap -- --login <管理员账号>
```

默认团队为“运营团队”，显示名称为“系统管理员”。可使用 `--team` 和 `--display-name` 指定名称。密码在交互终端隐藏输入并二次确认，长度为 8—256 个字符，与当前登录契约一致；不接受密码命令参数或管道，不提供固定默认密码。

口令使用 Node.js 内置 scrypt（N=131072、r=8、p=1）、16 字节随机盐和 64 字节派生值；保存带版本、参数、盐和派生值的编码。后续 Session 登录应复用 `backend/src/password.ts` 的验证函数。算法参考 [Node.js crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) 和 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)。密码和哈希不进入命令输出或审计。

脚本使用 Drizzle 事务、事务级 advisory lock 和团队/成员表锁，避免并发执行重复创建。已有任何成员时拒绝执行，不覆盖账号或密码；唯一同名团队可复用，多个团队或名称不匹配时拒绝。审计失败时整笔事务回滚。脚本不运行迁移、不改数据库角色权限。

离线密码单元测试包含在后端 `npm test` 中。数据库集成测试显式使用独立临时 PostgreSQL 库：

```sh
npm run admin:test
```

运行前通过测试进程环境设置 `BOOTSTRAP_TEST_DATABASE_URL`。它必须指向名为 `bootstrap_test_<12位随机十六进制>` 的可丢弃数据库；测试不读取项目 `.env`，会清空该临时库的测试记录，并覆盖重复执行、并发、回滚和普通业务角色权限。不可指向业务库或记忆库。
