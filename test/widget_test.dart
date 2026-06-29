import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tenmon_shirokita2026/main.dart';

void main() {
  testWidgets('festival dashboard supports core operations', (tester) async {
    await tester.pumpWidget(const FestivalDxApp());
    await tester.pumpAndSettle();

    expect(find.text('天文学研究部 城北祭DX'), findsWidgets);
    expect(find.text('予約人数'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.event_seat_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('当日入場を記録').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('当日 1名'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.point_of_sale_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.text('待ち').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('星空焼きそば').first);
    await tester.pumpAndSettle();
    expect(find.text('合計 ¥400'), findsOneWidget);
    await tester.tap(find.text('確定'));
    await tester.pumpAndSettle();
    expect(find.text('1'), findsOneWidget);

    final store = FestivalStore.seeded();
    store.toggleFinancePermission('staff-2');
    expect(store.accounts[1].extraPermissions, contains('会計確認'));
  });
}
