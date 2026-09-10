# 公開のしかた

配布先は2つある。**普段は Vercel の URL を配る。** GitHub Pages は鍵の要らない予備。

| | Vercel | GitHub Pages |
| --- | --- | --- |
| URL | `vercel` の deploy が出す | https://kawashimawataru.github.io/toikake/ |
| ラリー（Gemini） | 使える | **使えない**（アプリが自動でオフにする） |
| Gemini の鍵 | Vercel の環境変数にだけ置く | 置かない |
| オフライン | 使える（Service Worker） | 使える |

同じソースなので、どちらの URL でも記録は同じ形で取れる。
Vercel が落ちたら Pages の URL に切り替えれば当日は回る。

## Vercel（ラリーを使う側）

`vercel login` は対話式なので河島が1回打つ。そのあとは deploy するだけ。

```bash
# 1. ログイン（河島が1回）
vercel login

# 2. 公開（web/ で実行）
cd web
vercel --prod

# 3. Gemini の鍵を入れる。リポジトリには絶対に置かない
vercel env add GEMINI_API_KEY production   # Google AI Studio で取った鍵を貼る
vercel --prod                              # 環境変数を反映するためもう一度

# 4. 確認：{"ok":true,"ready":true} が返れば鍵が効いている
curl -s https://<出てきたURL>/api/rally
```

モデル名は決め打ちしていない。関数が起動時に使えるモデルを問い合わせて、
速いもの（flash 系）を選ぶ。固定したいときだけ `GEMINI_MODEL` を足す。

**FW が終わったら鍵を無効化する。**

## GitHub Pages（予備）

```bash
cd web && git add -A && git commit -m "…" && git push
```
数十秒で https://kawashimawataru.github.io/toikake/ に反映される。

## 出す前に必ず

```bash
cd web
RALLY=off node verify.mjs   # 定型だけで通しで動くか（Pages と同じ状態）
RALLY=on  node verify.mjs   # ラリーが動くか
RALLY=bad node verify.mjs   # 変な問いが返ってきても学生に出さないか
```
