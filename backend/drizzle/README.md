# 业务 SQL 迁移

表定义位于 `backend/src/schema.ts`。业务功能实现时添加表定义，运行根目录的 `npm run db:generate` 生成 SQL 和快照，将二者一起提交评审，再通过 `npm run db:migrate` 应用到业务库。

当前尚未实现业务表，不生成虚构迁移，也不把空迁移视为业务持久化已完成。禁止使用 schema push 绕过 SQL 评审。Mem0 检索表与 SQLite 历史不由 Drizzle 管理。
