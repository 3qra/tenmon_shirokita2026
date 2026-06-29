# 天文学研究部 城北祭DX化ツール

以下、このアプリの要件について書き連ねる。
・大きく分けて屋台・プラネタリウムの２つの催しに対して統括的に管理するためのシステムを考える。
・プラネタリウムは事前予約ができるように、予約枠を設けることができる。また、現時点では料金を取る予定はないが、入館料をとるようになった場合に備えて売り上げの項目を作成しておく
・プラネタリウムは１機で稼働予定だが、増設できるように想定しておく
・管理者側からは、予約できる日程テーブルの作成、予約枠の幅、予約に対する定員の設定、予約している人の情報などについて参照できるようにする
・当日参加の人の計上のためにもスタッフ側が当日入場のカウンターを上げることができる。
・当日度の時間にどれだけ来たかはきちんとログを取っておくこと。

・屋台について、スタッフのＰＯＳシステムを基幹とする。
・アプリ側でワンタップで注文の売り上げを上げることができるシステムを作成する。
・即時提供とウェイトの２種類を設ける。ウェイトの場合、整理番号を発行して、その番号が呼ばれるまで待ってもらうことになる。
・商品の品ぞろえ、商品に対するオプション（例えば、マヨネーズ抜きとか）、値段の推移（割引とか）も柔軟にログとして保存できるようにしておくこと。

・売上金については、アカウントと紐つけてだれがいくら持っているかを適切に幹部が把握できるようにすること。
・これらを保存するためのデータベースを別途用意する

## パーミッションについて
以下のようにパーミッションポリシーを定める
・役職ロールを幹部、スタッフ、技術者の3つに定め、それぞれデフォルトの権限を設定する。
・ロールとは別に権限を個人で設定することもできる。

A new Flutter project.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Lab: Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Cookbook: Useful Flutter samples](https://docs.flutter.dev/cookbook)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
