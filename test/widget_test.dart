import 'package:flutter_test/flutter_test.dart';

import 'package:tenmon_shirokita2026/main.dart';

void main() {
  testWidgets('shows login form for backend operation', (tester) async {
    await tester.pumpWidget(const FestivalDxApp());

    expect(find.text('天文学研究部 城北祭DX'), findsOneWidget);
    expect(find.text('ログインID'), findsOneWidget);
    expect(find.text('パスワード'), findsOneWidget);
    expect(find.text('ログイン'), findsOneWidget);
    expect(find.textContaining('接続先:'), findsOneWidget);
  });
}
