# 隔离 SSH / SFTP 测试夹具

此目录供桌面测试和移动原型复用，不依赖 Rust。服务仅绑定 `127.0.0.1`，使用每次生成的密钥、临时身份和独立目录，不读取用户的 `.ssh` 配置或真实服务器凭据。

## 桌面集成测试

在仓库根目录安装依赖：

```sh
python -m pip install -r test-support/ssh/requirements.txt
cd desktop
node scripts/ci-tests.mjs
```

脚本创建有生命周期上限的临时服务，等待 readiness 文件，再为测试传入 `GOOESHELL_SFTP_TEST_READY`，最后停止服务。日志和临时文件位于 `desktop/test-output/`。

## 单独启动

```sh
python test-support/ssh/sftp_fixture.py --root .build/sftp-tests --ready .build/sftp-test.ready --lifetime 600
```

readiness 文件包含该次测试的根目录标记、回环端口、测试身份和服务器指纹，应仅用于本机临时测试，不提交到仓库。`selftest_fixture.py` 可用于检查已经启动的夹具；传参见脚本的 `--help`。
