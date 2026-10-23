# 学祭ポータル iOS（SwiftUI ＋ App Clip）

来場者向けのモバイル注文（App Clip）と、通常版アプリ（注文・プラネタリウム予約・マイチケット・スタッフ機能）です。
価格計算・権限・定員・状態遷移・割引判定はすべて Go API（`/api/v1`）が行い、アプリは表示と送信だけを行います。

- 対応OS: iOS 17 以上
- 依存: Apple 標準フレームワークのみ（SwiftUI / Observation / AVFoundation / CoreImage / PassKit / StoreKit / Security）
- 外部ライブラリ（SPM）は使用しません

> **重要**: App Clip・関連ドメイン・Wallet・審査に関する Apple の仕様は変わることがあります。
> 実装・リリースの時点で必ず Apple の公式ドキュメントを再確認してください（仕様書 §6・§21）。

## ディレクトリ構成

```
ios/
├── project.yml           XcodeGen のプロジェクト定義（.xcodeproj はここから生成）
├── Shared/               アプリと App Clip の両方でコンパイルする共通コード
│   ├── APIClient.swift   async/await の API クライアント、エラー（日本語）、日時解析
│   ├── Models.swift      API の JSON に対応する Codable モデル
│   ├── ClientIdentity.swift / Idempotency.swift / KeychainStore.swift
│   ├── SSEClient.swift   /events の購読（自動再接続）
│   ├── QRCodeView.swift / Formatters.swift / TokenStore.swift / DeepLink.swift / UIComponents.swift
│   └── Ordering/         注文の画面（メニュー・選択肢・カート・確認コード・注文状況）
├── Clip/                 App Clip（注文のみ）
└── App/                  通常版アプリ（プラネタリウム・マイチケット・スタッフ）
```

## プロジェクトの生成

Xcode 16 以上と [XcodeGen](https://github.com/yonaskolb/XcodeGen) が必要です。

```sh
brew install xcodegen
cd ios
xcodegen generate
open GakusaiPortal.xcodeproj
```

`GakusaiPortal.xcodeproj`・`App/Info.plist`・`Clip/Info.plist`・`*.entitlements` は `project.yml` から生成されます。
手で編集せず、`project.yml` を変更して再生成してください（生成物はリポジトリに含めなくても構いません）。

## 置き換えが必要な設定

`project.yml` の `← 置き換える` と書かれた箇所を変更します。

| 項目 | 既定値（プレースホルダー） | 変更内容 |
|---|---|---|
| `DEVELOPMENT_TEAM` | 空 | Apple Developer の Team ID |
| アプリのバンドルID | `jp.example.gakusai` | 本番のID |
| App Clip のバンドルID | `jp.example.gakusai.Clip` | `<アプリのID>.Clip`（親アプリIDで始まる必要あり） |
| `parent-application-identifiers` | `$(AppIdentifierPrefix)jp.example.gakusai` | 親アプリのIDに合わせる |
| 関連ドメイン | `appclips:example.com` / `applinks:example.com` | 本番ドメイン |
| `API_BASE_URL` / `WEB_BASE_URL` | Release: `https://example.com`、Debug: `http://localhost:8080` / `http://localhost:3000` | 接続先 |

- `API_BASE_URL` は API のオリジンです（`/api/v1` はアプリが付けます）。ビルド構成ごとに上書きできます。
  `.xcconfig` で上書きする場合、`//` がコメント扱いになるため `https:/$()/example.com` のように書きます。
- 実機から開発用 API に接続するときは、Debug の値を Mac の LAN アドレス（例 `http://192.168.0.10:8080`）に変えます。
  `NSAllowsLocalNetworking` によりローカルネットワークの http だけ許可しています（本番は HTTPS 必須）。
- 秘密情報（証明書・鍵・パスワード）はアプリに含めません。Wallet の署名はサーバー側で行います。

## 関連ドメイン（AASA）

サーバーの `https://<domain>/.well-known/apple-app-site-association` を HTTPS・リダイレクトなし・
`Content-Type: application/json` で配信します。`ABCDE12345` は Team ID に置き換えてください。

```json
{
  "appclips": {
    "apps": ["ABCDE12345.jp.example.gakusai.Clip"]
  },
  "applinks": {
    "details": [
      {
        "appIDs": ["ABCDE12345.jp.example.gakusai"],
        "components": [
          { "/": "/order/*", "comment": "モバイル注文" },
          { "/": "/o/*", "comment": "注文状況" },
          { "/": "/r/*", "comment": "予約確認・チケット" },
          { "/": "/c/*", "comment": "クーポン" }
        ]
      }
    ]
  }
}
```

アプリが扱うURL:

| URL | アプリ側の動作 |
|---|---|
| `https://<domain>/order/<部門ID>` | App Clip の呼び出しURL。該当部門のメニューを開く（通常版では「注文」タブ） |
| `https://<domain>/o/<token>` | 注文状況 |
| `https://<domain>/r/<token>` | 予約確認・チケット（通常版の「マイチケット」） |
| `https://<domain>/c/<token>` | クーポン（通常版の「マイチケット」） |

同じURLは Web（Next.js）にもページがあるため、アプリ未導入でもブラウザで開けます。

## App Clip の体験設定（App Store Connect）

1. App Store Connect でアプリを作成し、App Clip を含むビルドをアップロードする。
2. 「App Clip エクスペリエンス」の既定エクスペリエンス（タイトル・サブタイトル・画像・「開く」ボタン）を設定する。
3. 店頭ポスター・QRコード・NFC から部門ごとに起動するため、高度なエクスペリエンスとして
   `https://<domain>/order/<部門ID>` を登録する（部門IDは `GET /api/v1/public/departments` で確認）。
4. 店頭に掲示するQRコードには同じURLを入れる。App Clip Code を使う場合は App Store Connect で生成する。

### App Clip 非対応端末のフォールバック

App Clip が使えない端末（古いOS・Android・機能制限中など）では、同じURLが Safari 等で開き、
Web の注文画面（`/order/<部門ID>`）が表示されます。店頭掲示にはこの点を書き添えてください。
App Clip で作成した注文は App Clip 内に保存され、通常版アプリへは引き継がれません（注文状況URLで確認できます）。

## ローカルでの App Clip テスト

- スキーム `GakusaiPortalClip` の Run 環境変数 `_XCAppClipURL` に呼び出しURLを設定しています。
  `00000000-...` を、ローカル API の `GET http://localhost:8080/api/v1/public/departments` で得た「やきうどん」の `id` に置き換えて実行します。
- 実機では「設定 → デベロッパ → ローカルエクスペリエンス」に URL とバンドルIDを登録すると、QRコードから起動を試せます。
- 現地確認コードが有効な部門では、管理者または表示端末アカウントで Web の表示画面に出る3桁コードを入力します。

## Apple Wallet

- 予約チケットの `.pkpass` はサーバーが署名して `GET /public/reservations/by-token/{token}/tickets/{seq}/wallet` で返します。
- 予約詳細の `wallet_enabled` が `true` のときだけ「Apple Walletに追加」ボタンを表示します。
- サーバー側に Pass Type ID 証明書・鍵の設定が必要です（Apple Developer で Pass Type ID を作成）。証明書はアプリに含めません。
- Wallet に追加しなくても、アプリ／Web の QR コードで入場できます。入場可否は常に API の最新状態で判定されます。
- 発行済みパスへの上映中止・時刻変更の自動反映（パス更新Webサービス）は未対応です。予約確認画面で最新状態を確認してください。

## 仕組みのメモ

- **来場者識別**: `X-Client-Id`（ランダムUUID）と `X-Client-Kind`（`ios` / `appclip`）を送ります。
  通常版はキーチェーン、App Clip は UserDefaults に保存します。端末の永久識別ではありません。
- **冪等性**: 注文作成・予約・チェックインは、利用者の1操作につき `Idempotency-Key` を1つ発行し、
  通信断・5xx・409・429 のときは同じキーで再送します。内容が変わったら新しいキーにします。
- **リアルタイム更新**: `/api/v1/events?topics=...`（SSE）の通知を受けたら API から取り直します。
  切断時は自動再接続し、併せて一定間隔で再取得します。通信できないときは「表示が古い可能性があります」と表示します。
- **スタッフ**: ログイントークンはキーチェーンに保存し、`Authorization: Bearer` で送ります。
  アプリでできるのは QR 入場チェックイン、クーポン確認（読み取りのみ・消費しない）、キッチン操作です。
  会計・受け渡し・当日受付・現金・シフト・管理は「Web管理画面を開く」から Web で行います。
- **アクセシビリティ**: Dynamic Type 対応のテキストスタイル、44pt 以上のボタン、状態はアイコン＋文字で表示（色だけに頼らない）。
  カメラが拒否された場合はチケット番号・クーポンコードの手入力で照会できます。
