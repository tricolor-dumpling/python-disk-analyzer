# P12 前旧草稿测试归档（UI2.0·U1.0 基线核定）

本目录存放 10 个**未跟踪**的 P12 定稿前测试草稿（test_web/test_refresh/
test_dispatcher 等）。它们断言的是 P12 重构前的旧行为（例如 fullscan 启动
toast「已启动」→ P12·W2.5(G) 已改为「任务已提交」；健康文案「Everything
不可用」→ P12·W1.3 已改为 degraded 分类文案），与当前源码不匹配，
混入 `unittest discover` 会造成门禁假红。

依据《docs/UI2.0_开发执行手册.md》U1.0 基线核定，归档于此（目录无
__init__.py，discovery 不再收集）；权威门禁以 git 跟踪的 tests/ 为准。
如后续迭代需要其中的用例思路，请按当前源码语义重写后再纳入。
