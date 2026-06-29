import 'package:flutter/material.dart';

void main() {
  runApp(const FestivalDxApp());
}

class FestivalDxApp extends StatelessWidget {
  const FestivalDxApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '天文学研究部 城北祭DX',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff0f766e),
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: const Color(0xfff4f7f6),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xff0f766e),
          foregroundColor: Colors.white,
          centerTitle: false,
        ),
        navigationRailTheme: const NavigationRailThemeData(
          backgroundColor: Color(0xffe0f2f1),
          selectedIconTheme: IconThemeData(color: Color(0xff0f766e)),
          selectedLabelTextStyle: TextStyle(
            color: Color(0xff0f766e),
            fontWeight: FontWeight.w700,
          ),
          indicatorColor: Color(0xffb2dfdb),
        ),
        cardTheme: CardThemeData(
          color: Colors.white,
          elevation: 1.5,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
        useMaterial3: true,
      ),
      home: const FestivalHomePage(),
    );
  }
}

class FestivalHomePage extends StatefulWidget {
  const FestivalHomePage({super.key});

  @override
  State<FestivalHomePage> createState() => _FestivalHomePageState();
}

class _FestivalHomePageState extends State<FestivalHomePage> {
  final FestivalStore store = FestivalStore.seeded();
  int selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      DashboardView(store: store),
      PlanetariumView(store: store, onChanged: _refresh),
      StandPosView(store: store, onChanged: _refresh),
      PlanetariumAdminView(store: store, onChanged: _refresh),
      StandAdminView(store: store, onChanged: _refresh),
      FinanceView(store: store, onChanged: _refresh),
      SettingsView(store: store, onChanged: _refresh),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('天文学研究部 城北祭DX'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(
              child: Text(
                'ログ ${store.auditLogs.length}件',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ),
          ),
        ],
      ),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: selectedIndex,
            onDestinationSelected: (value) {
              setState(() => selectedIndex = value);
            },
            labelType: NavigationRailLabelType.all,
            destinations: const [
              NavigationRailDestination(
                icon: Icon(Icons.dashboard_outlined),
                selectedIcon: Icon(Icons.dashboard),
                label: Text('概要'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.event_seat_outlined),
                selectedIcon: Icon(Icons.event_seat),
                label: Text('プラネタリウム'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.point_of_sale_outlined),
                selectedIcon: Icon(Icons.point_of_sale),
                label: Text('屋台'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.event_note_outlined),
                selectedIcon: Icon(Icons.event_note),
                label: Text('プラネタリウム管理'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.restaurant_menu_outlined),
                selectedIcon: Icon(Icons.restaurant_menu),
                label: Text('屋台管理'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.account_balance_wallet_outlined),
                selectedIcon: Icon(Icons.account_balance_wallet),
                label: Text('売上金'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.settings_outlined),
                selectedIcon: Icon(Icons.settings),
                label: Text('設定'),
              ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: pages[selectedIndex]),
        ],
      ),
    );
  }

  void _refresh() {
    setState(() {});
  }
}

class DashboardView extends StatelessWidget {
  const DashboardView({super.key, required this.store});

  final FestivalStore store;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '運用概要',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              MetricTile(
                label: '予約人数',
                value: '${store.reservedGuests}',
                icon: Icons.confirmation_number_outlined,
              ),
              MetricTile(
                label: '当日入場',
                value: '${store.walkInTotal}',
                icon: Icons.groups_outlined,
              ),
              MetricTile(
                label: '屋台売上',
                value: yen(store.standSalesTotal),
                icon: Icons.receipt_long_outlined,
              ),
              MetricTile(
                label: '預かり現金',
                value: yen(store.cashOnHandTotal),
                icon: Icons.payments_outlined,
              ),
            ],
          ),
          const SizedBox(height: 24),
          Text('最新ログ', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Expanded(
            child: AuditLogList(
              logs: store.auditLogs.reversed.take(14).toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class PlanetariumView extends StatefulWidget {
  const PlanetariumView({
    super.key,
    required this.store,
    required this.onChanged,
  });

  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  State<PlanetariumView> createState() => _PlanetariumViewState();
}

class _PlanetariumViewState extends State<PlanetariumView> {
  late String selectedScheduleId = widget.store.schedules.first.id;

  @override
  Widget build(BuildContext context) {
    final schedule = widget.store.schedules.firstWhere(
      (item) => item.id == selectedScheduleId,
    );

    return AppPage(
      title: 'プラネタリウム予約',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 12,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              SegmentedButton<String>(
                segments: [
                  for (final item in widget.store.schedules)
                    ButtonSegment(
                      value: item.id,
                      label: Text(item.dateLabel),
                      icon: const Icon(Icons.calendar_month),
                    ),
                ],
                selected: {selectedScheduleId},
                onSelectionChanged: (values) {
                  setState(() => selectedScheduleId = values.first);
                },
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: PlanetariumTimeline(
              schedule: schedule,
              store: widget.store,
              onChanged: widget.onChanged,
            ),
          ),
        ],
      ),
    );
  }
}

class PlanetariumTimeline extends StatelessWidget {
  const PlanetariumTimeline({
    super.key,
    required this.schedule,
    required this.store,
    required this.onChanged,
  });

  final PlanetariumSchedule schedule;
  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final rooms = schedule.slots.map((slot) => slot.roomName).toSet().toList()
      ..sort();
    const startHour = 8;
    const endHour = 19;
    const hourHeight = 82.0;
    const timeWidth = 92.0;
    const roomWidth = 310.0;
    const bodyHeight = (endHour - startHour) * hourHeight;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: timeWidth + 8 + rooms.length * roomWidth,
            child: Column(
              children: [
                Row(
                  children: [
                    const CalendarHeaderCell(label: '時間', width: timeWidth),
                    for (final room in rooms)
                      CalendarHeaderCell(label: room, width: roomWidth - 8),
                  ],
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: SingleChildScrollView(
                    child: SizedBox(
                      height: bodyHeight,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: timeWidth,
                            height: bodyHeight,
                            child: Stack(
                              children: [
                                for (
                                  var hour = startHour;
                                  hour <= endHour;
                                  hour++
                                )
                                  Positioned(
                                    top: (hour - startHour) * hourHeight,
                                    left: 0,
                                    right: 8,
                                    child: Text(
                                      '${hour.toString().padLeft(2, '0')}:00',
                                      style: Theme.of(
                                        context,
                                      ).textTheme.labelLarge,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          for (final room in rooms)
                            SizedBox(
                              width: roomWidth,
                              height: bodyHeight,
                              child: Stack(
                                children: [
                                  for (
                                    var hour = 0;
                                    hour <= endHour - startHour;
                                    hour++
                                  )
                                    Positioned(
                                      top: hour * hourHeight,
                                      left: 0,
                                      right: 8,
                                      child: const Divider(height: 1),
                                    ),
                                  for (final slot in schedule.slots.where(
                                    (slot) => slot.roomName == room,
                                  ))
                                    Positioned(
                                      top:
                                          (slot.startMinutes - startHour * 60) /
                                          60 *
                                          hourHeight,
                                      left: 0,
                                      width: roomWidth - 8,
                                      height:
                                          slot.durationMinutes /
                                          60 *
                                          hourHeight,
                                      child: TimelineEventBlock(
                                        slot: slot,
                                        store: store,
                                        onChanged: onChanged,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class CalendarHeaderCell extends StatelessWidget {
  const CalendarHeaderCell({
    super.key,
    required this.label,
    required this.width,
  });

  final String label;
  final double width;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primary,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
          color: Colors.white,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class TimelineEventBlock extends StatelessWidget {
  const TimelineEventBlock({
    super.key,
    required this.slot,
    required this.store,
    required this.onChanged,
  });

  final PlanetariumSlot slot;
  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final value = slot.reservedCount / slot.capacity;
    final background = value >= 0.9
        ? const Color(0xffef4444)
        : value >= 0.5
        ? const Color(0xfff97316)
        : const Color(0xff0ea5e9);

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${slot.title}  ${slot.roomName}',
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Colors.white,
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            '${slot.timeLabel}〜${slot.endTimeLabel}',
            style: const TextStyle(color: Colors.white),
          ),
          Text(
            '予約 ${slot.reservedCount}/${slot.capacity}名 / 当日 ${slot.walkIns}名',
            style: const TextStyle(color: Colors.white),
          ),
          const Spacer(),
          Row(
            children: [
              IconButton.filledTonal(
                tooltip: '予約を追加',
                onPressed: slot.reservedCount >= slot.capacity
                    ? null
                    : () {
                        store.addReservation(slot.id);
                        onChanged();
                      },
                icon: const Icon(Icons.person_add_alt_1),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                tooltip: '当日入場を記録',
                onPressed: () {
                  store.addWalkIn(slot.id);
                  onChanged();
                },
                icon: const Icon(Icons.login),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class PlanetariumAdminView extends StatelessWidget {
  const PlanetariumAdminView({
    super.key,
    required this.store,
    required this.onChanged,
  });

  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: 'プラネタリウム管理',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ListView(
              children: [
                AdminPanel(
                  color: const Color(0xffe0f2fe),
                  icon: Icons.meeting_room_outlined,
                  title: '投影機',
                  subtitle: 'デフォルトは1機。増設すると各日程に新しい投影枠を追加します。',
                  trailing: Text(
                    '${store.roomCount}機',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  action: FilledButton.icon(
                    onPressed: () {
                      store.addRoom();
                      onChanged();
                    },
                    icon: const Icon(Icons.add),
                    label: const Text('投影機を追加'),
                  ),
                ),
                const SizedBox(height: 12),
                AdminPanel(
                  color: const Color(0xfffff7ed),
                  icon: Icons.event_available_outlined,
                  title: '投影スケジュール',
                  subtitle: '予約受付に使う日程テーブルを作成します。',
                  trailing: Text(
                    '${store.schedules.length}日程',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  action: FilledButton.tonalIcon(
                    onPressed: () {
                      store.addSchedule();
                      onChanged();
                    },
                    icon: const Icon(Icons.calendar_month),
                    label: const Text('日程を作成'),
                  ),
                ),
                const SizedBox(height: 16),
                Text('現在の枠', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                for (final schedule in store.schedules)
                  Card(
                    child: ExpansionTile(
                      leading: const Icon(Icons.today_outlined),
                      title: Text(schedule.dateLabel),
                      subtitle: Text('${schedule.slots.length}枠'),
                      children: [
                        for (final slot in schedule.slots)
                          ListTile(
                            leading: const Icon(Icons.schedule),
                            title: Text('${slot.timeLabel} ${slot.roomName}'),
                            subtitle: Text('定員 ${slot.capacity}名'),
                            trailing: Text('予約 ${slot.reservedCount}名'),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          SizedBox(
            width: 340,
            child: AuditLogList(
              title: '管理ログ',
              logs: store.auditLogs
                  .where((log) => log.category == LogCategory.planetarium)
                  .toList()
                  .reversed
                  .toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class StandPosView extends StatefulWidget {
  const StandPosView({super.key, required this.store, required this.onChanged});

  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  State<StandPosView> createState() => _StandPosViewState();
}

class _StandPosViewState extends State<StandPosView> {
  Fulfillment fulfillment = Fulfillment.instant;
  final List<MenuItem> cart = [];

  @override
  Widget build(BuildContext context) {
    final total = cart.fold(0, (sum, item) => sum + item.currentPrice);

    return AppPage(
      title: '屋台',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SegmentedButton<Fulfillment>(
            segments: const [
              ButtonSegment(
                value: Fulfillment.instant,
                icon: Icon(Icons.flash_on),
                label: Text('即時'),
              ),
              ButtonSegment(
                value: Fulfillment.waiting,
                icon: Icon(Icons.timer_outlined),
                label: Text('待ち'),
              ),
            ],
            selected: {fulfillment},
            onSelectionChanged: (values) {
              setState(() => fulfillment = values.first);
            },
          ),
          const SizedBox(height: 16),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  flex: 2,
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final crossAxisCount = constraints.maxWidth >= 760
                          ? 3
                          : constraints.maxWidth >= 420
                          ? 2
                          : 1;
                      return GridView.count(
                        crossAxisCount: crossAxisCount,
                        mainAxisSpacing: 12,
                        crossAxisSpacing: 12,
                        childAspectRatio: crossAxisCount == 1 ? 2.0 : 1.0,
                        children: [
                          for (final item in widget.store.menuItems)
                            MenuItemButton(
                              item: item,
                              onPressed: () {
                                setState(() => cart.add(item));
                              },
                            ),
                        ],
                      );
                    },
                  ),
                ),
                const SizedBox(width: 16),
                SizedBox(
                  width: 390,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '注文候補',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      Expanded(
                        child: cart.isEmpty
                            ? const Center(child: Text('商品を選択してください'))
                            : ListView.builder(
                                itemCount: cart.length,
                                itemBuilder: (context, index) {
                                  final item = cart[index];
                                  return Card(
                                    child: ListTile(
                                      title: Text(item.name),
                                      subtitle: Text(item.options.join(' / ')),
                                      trailing: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text(yen(item.currentPrice)),
                                          IconButton(
                                            tooltip: '削除',
                                            onPressed: () {
                                              setState(
                                                () => cart.removeAt(index),
                                              );
                                            },
                                            icon: const Icon(Icons.close),
                                          ),
                                        ],
                                      ),
                                    ),
                                  );
                                },
                              ),
                      ),
                      Card(
                        color: const Color(0xffe0f2f1),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  '合計 ${yen(total)}',
                                  style: Theme.of(context).textTheme.titleLarge,
                                ),
                              ),
                              FilledButton.icon(
                                onPressed: cart.isEmpty
                                    ? null
                                    : () {
                                        widget.store.confirmOrder(
                                          cart,
                                          fulfillment: fulfillment,
                                        );
                                        setState(() => cart.clear());
                                        widget.onChanged();
                                      },
                                icon: const Icon(Icons.check),
                                label: const Text('確定'),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        '待ち番号',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      SizedBox(
                        height: 190,
                        child: ListView(
                          children: [
                            for (final order in widget.store.orders.reversed)
                              if (order.fulfillment == Fulfillment.waiting)
                                Card(
                                  child: ListTile(
                                    leading: CircleAvatar(
                                      child: Text('${order.waitNumber}'),
                                    ),
                                    title: Text(order.itemName),
                                    subtitle: Text(yen(order.price)),
                                    trailing: order.completed
                                        ? const Icon(Icons.check_circle)
                                        : FilledButton(
                                            onPressed: () {
                                              widget.store.completeOrder(
                                                order.id,
                                              );
                                              widget.onChanged();
                                            },
                                            child: const Text('呼出済'),
                                          ),
                                  ),
                                ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class MenuItemButton extends StatelessWidget {
  const MenuItemButton({
    super.key,
    required this.item,
    required this.onPressed,
  });

  final MenuItem item;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.all(14),
        backgroundColor: const Color(0xff0ea5e9),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      onPressed: onPressed,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: item.imagePath.isEmpty
                ? const Icon(Icons.fastfood, size: 42, color: Colors.white)
                : const Icon(Icons.image, size: 42, color: Colors.white),
          ),
          Text(
            item.name,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: Colors.white,
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            yen(item.currentPrice),
            style: const TextStyle(color: Colors.white),
          ),
        ],
      ),
    );
  }
}

class StandAdminView extends StatelessWidget {
  const StandAdminView({
    super.key,
    required this.store,
    required this.onChanged,
  });

  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '屋台管理',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ListView(
              children: [
                AdminPanel(
                  color: const Color(0xfffef3c7),
                  icon: Icons.add_business_outlined,
                  title: 'メニュー種類',
                  subtitle: '販売する商品を追加します。',
                  trailing: Text(
                    '${store.menuItems.length}品',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  action: FilledButton.icon(
                    onPressed: () {
                      store.addMenuItem();
                      onChanged();
                    },
                    icon: const Icon(Icons.add),
                    label: const Text('商品を追加'),
                  ),
                ),
                const SizedBox(height: 16),
                for (final item in store.menuItems)
                  MenuItemEditor(
                    item: item,
                    store: store,
                    onChanged: onChanged,
                  ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          SizedBox(
            width: 340,
            child: AuditLogList(
              title: '商品管理ログ',
              logs: store.auditLogs
                  .where((log) => log.category == LogCategory.stand)
                  .toList()
                  .reversed
                  .toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class MenuItemEditor extends StatelessWidget {
  const MenuItemEditor({
    super.key,
    required this.item,
    required this.store,
    required this.onChanged,
  });

  final MenuItem item;
  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 86,
                  height: 86,
                  decoration: BoxDecoration(
                    color: const Color(0xffe0f2f1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    item.imagePath.isEmpty ? Icons.fastfood : Icons.image,
                    size: 36,
                    color: const Color(0xff0f766e),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    children: [
                      TextFormField(
                        initialValue: item.name,
                        decoration: const InputDecoration(labelText: '商品名'),
                        onChanged: (value) {
                          store.renameMenuItem(item.id, value);
                          onChanged();
                        },
                      ),
                      const SizedBox(height: 8),
                      TextFormField(
                        initialValue: item.currentPrice.toString(),
                        decoration: const InputDecoration(labelText: '値段'),
                        keyboardType: TextInputType.number,
                        onChanged: (value) {
                          final price = int.tryParse(value);
                          if (price != null) {
                            store.setMenuPrice(item.id, price);
                            onChanged();
                          }
                        },
                      ),
                      const SizedBox(height: 8),
                      TextFormField(
                        initialValue: item.imagePath,
                        decoration: const InputDecoration(
                          labelText: '画像URL/パス',
                        ),
                        onChanged: (value) {
                          store.setMenuImage(item.id, value);
                          onChanged();
                        },
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text('オプション', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            for (var index = 0; index < item.options.length; index++)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: TextFormField(
                  initialValue: item.options[index],
                  decoration: InputDecoration(labelText: 'オプション${index + 1}'),
                  onChanged: (value) {
                    store.renameMenuOption(item.id, index, value);
                    onChanged();
                  },
                ),
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () {
                    store.addMenuOption(item.id);
                    onChanged();
                  },
                  icon: const Icon(Icons.playlist_add),
                  label: const Text('オプション追加'),
                ),
                FilledButton.tonalIcon(
                  onPressed: () {
                    store.discountMenuItem(item.id);
                    onChanged();
                  },
                  icon: const Icon(Icons.sell_outlined),
                  label: const Text('50円値引き'),
                ),
                FilledButton.icon(
                  onPressed: () {
                    store.raiseMenuItemPrice(item.id);
                    onChanged();
                  },
                  icon: const Icon(Icons.trending_up),
                  label: const Text('50円値上げ'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              '価格履歴: ${item.priceHistory.map((p) => '${yen(p.price)} ${p.reason}').join(' → ')}',
            ),
          ],
        ),
      ),
    );
  }
}

class MenuItemTile extends StatelessWidget {
  const MenuItemTile({
    super.key,
    required this.item,
    required this.onInstant,
    required this.onWait,
  });

  final MenuItem item;
  final VoidCallback onInstant;
  final VoidCallback onWait;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    item.name,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                Text(yen(item.currentPrice)),
              ],
            ),
            const SizedBox(height: 8),
            Text('オプション: ${item.options.join(' / ')}'),
            const Spacer(),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: onInstant,
                    icon: const Icon(Icons.flash_on),
                    label: const Text('即時'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: onWait,
                    icon: const Icon(Icons.timer_outlined),
                    label: const Text('待ち'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class FinanceView extends StatelessWidget {
  const FinanceView({super.key, required this.store, required this.onChanged});

  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '売上金管理',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ListView(
              children: [
                for (final account in store.accounts)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.person),
                      title: Text(account.name),
                      subtitle: Text(
                        '${roleLabel(account.role)} / ${account.cashMemo}',
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            yen(account.cashOnHand),
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(width: 12),
                          IconButton.filledTonal(
                            tooltip: '現金を預ける',
                            onPressed: () {
                              store.addCash(account.id, 1000);
                              onChanged();
                            },
                            icon: const Icon(Icons.add),
                          ),
                          const SizedBox(width: 8),
                          IconButton.outlined(
                            tooltip: '1000円回収',
                            onPressed: account.cashOnHand <= 0
                                ? null
                                : () {
                                    store.addCash(account.id, -1000);
                                    onChanged();
                                  },
                            icon: const Icon(Icons.remove),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          SizedBox(
            width: 360,
            child: AuditLogList(
              title: '会計ログ',
              logs: store.auditLogs
                  .where((log) => log.category == LogCategory.finance)
                  .toList()
                  .reversed
                  .toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class SettingsView extends StatelessWidget {
  const SettingsView({super.key, required this.store, required this.onChanged});

  final FestivalStore store;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '設定',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: ListView(
              children: [
                AdminPanel(
                  color: const Color(0xffeef2ff),
                  icon: Icons.admin_panel_settings_outlined,
                  title: '権限',
                  subtitle: 'ロール既定権限と個人別追加権限を管理します。',
                  trailing: Text(
                    '${store.accounts.length}人',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  action: const SizedBox.shrink(),
                ),
                const SizedBox(height: 16),
                Text('ロール既定権限', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                for (final role in StaffRole.values)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.verified_user_outlined),
                      title: Text(roleLabel(role)),
                      subtitle: Text(
                        store.defaultPermissions[role]!.join(' / '),
                      ),
                    ),
                  ),
                const SizedBox(height: 24),
                Text('個人別追加権限', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                for (final account in store.accounts)
                  Card(
                    child: ListTile(
                      title: Text(account.name),
                      subtitle: Text(
                        account.extraPermissions.isEmpty
                            ? '追加権限なし'
                            : account.extraPermissions.join(' / '),
                      ),
                      trailing: FilledButton.tonalIcon(
                        onPressed: () {
                          store.toggleFinancePermission(account.id);
                          onChanged();
                        },
                        icon: const Icon(Icons.tune),
                        label: const Text('会計権限'),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          SizedBox(
            width: 390,
            child: AuditLogList(
              title: 'ログ',
              logs: store.auditLogs.reversed.toList(),
            ),
          ),
        ],
      ),
    );
  }
}

class AdminPanel extends StatelessWidget {
  const AdminPanel({
    super.key,
    required this.color,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.trailing,
    required this.action,
  });

  final Color color;
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget trailing;
  final Widget action;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: color,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: Colors.white,
              foregroundColor: Theme.of(context).colorScheme.primary,
              child: Icon(icon),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Text(subtitle),
                ],
              ),
            ),
            const SizedBox(width: 12),
            trailing,
            const SizedBox(width: 12),
            action,
          ],
        ),
      ),
    );
  }
}

class AppPage extends StatelessWidget {
  const AppPage({super.key, required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 16),
          Expanded(child: child),
        ],
      ),
    );
  }
}

class MetricTile extends StatelessWidget {
  const MetricTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
  });

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 210,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Icon(icon, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: Theme.of(context).textTheme.labelLarge),
                    Text(value, style: Theme.of(context).textTheme.titleLarge),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class AuditLogList extends StatelessWidget {
  const AuditLogList({super.key, required this.logs, this.title});

  final List<AuditLog> logs;
  final String? title;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null) ...[
          Text(title!, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
        ],
        Expanded(
          child: logs.isEmpty
              ? const Center(child: Text('ログはまだありません'))
              : ListView.separated(
                  itemCount: logs.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final log = logs[index];
                    return ListTile(
                      dense: true,
                      leading: Icon(log.icon),
                      title: Text(log.message),
                      subtitle: Text(log.timeLabel),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

class FestivalStore {
  FestivalStore({
    required this.schedules,
    required this.menuItems,
    required this.accounts,
    required this.auditLogs,
  });

  final List<PlanetariumSchedule> schedules;
  final List<MenuItem> menuItems;
  final List<StaffAccount> accounts;
  final List<AuditLog> auditLogs;
  final Map<StaffRole, List<String>> defaultPermissions = {
    StaffRole.executive: ['全体管理', '予約編集', 'POS操作', '会計確認', '権限設定'],
    StaffRole.staff: ['予約閲覧', '当日入場記録', 'POS操作'],
    StaffRole.engineer: ['全体管理', 'DB保守', '権限設定', '監査ログ確認'],
  };

  int nextWaitNumber = 1;
  int nextGuestNumber = 4;
  int nextScheduleNumber = 3;
  int nextRoomNumber = 1;
  int nextMenuNumber = 5;
  final List<StandOrder> orders = [];

  static FestivalStore seeded() {
    final schedule = PlanetariumSchedule(
      id: 'schedule-1',
      dateLabel: '1日目',
      slots: [
        PlanetariumSlot(
          id: 'slot-1',
          timeLabel: '09:10',
          roomName: '投影機A',
          capacity: 24,
          title: '星空解説',
          durationMinutes: 100,
          reservations: [
            Reservation(guestName: '予約者A', partySize: 2),
            Reservation(guestName: '予約者B', partySize: 3),
          ],
        ),
        PlanetariumSlot(
          id: 'slot-2',
          timeLabel: '11:00',
          roomName: '投影機A',
          capacity: 24,
          title: 'プロセッサ設計',
          durationMinutes: 100,
          reservations: [Reservation(guestName: '予約者C', partySize: 4)],
        ),
        PlanetariumSlot(
          id: 'slot-3',
          timeLabel: '13:30',
          roomName: '投影機A',
          capacity: 24,
          title: 'プログラミング言語論',
          durationMinutes: 100,
        ),
      ],
    );

    return FestivalStore(
      schedules: [
        schedule,
        PlanetariumSchedule(
          id: 'schedule-2',
          dateLabel: '2日目',
          slots: [
            PlanetariumSlot(
              id: 'slot-4',
              timeLabel: '10:30',
              roomName: '投影機A',
              capacity: 24,
              title: '星座早見',
            ),
            PlanetariumSlot(
              id: 'slot-5',
              timeLabel: '12:00',
              roomName: '投影機A',
              capacity: 24,
              title: '太陽系ツアー',
            ),
          ],
        ),
      ],
      menuItems: [
        MenuItem(
          id: 'food-1',
          name: '星空焼きそば',
          basePrice: 400,
          priceHistory: [PriceChange(400, '通常価格')],
          options: ['マヨネーズ抜き', '青のり多め'],
        ),
        MenuItem(
          id: 'food-2',
          name: '月面フランク',
          basePrice: 300,
          priceHistory: [PriceChange(300, '通常価格')],
          options: ['ケチャップ抜き', 'からし追加'],
        ),
        MenuItem(
          id: 'drink-1',
          name: '銀河ソーダ',
          basePrice: 250,
          priceHistory: [PriceChange(250, '通常価格')],
          options: ['氷なし', '炭酸弱め'],
        ),
        MenuItem(
          id: 'set-1',
          name: '観測セット',
          basePrice: 600,
          priceHistory: [PriceChange(700, '開始価格'), PriceChange(600, '午後割引')],
          options: ['箸多め', '袋あり'],
        ),
      ],
      accounts: [
        StaffAccount(
          id: 'staff-1',
          name: '幹部A',
          role: StaffRole.executive,
          cashOnHand: 12000,
          cashMemo: '本部金庫',
        ),
        StaffAccount(
          id: 'staff-2',
          name: 'スタッフB',
          role: StaffRole.staff,
          cashOnHand: 3500,
          cashMemo: '屋台レジ',
        ),
        StaffAccount(
          id: 'staff-3',
          name: '技術者C',
          role: StaffRole.engineer,
          cashOnHand: 0,
          cashMemo: '端末管理',
        ),
      ],
      auditLogs: [
        AuditLog(
          category: LogCategory.system,
          message: '初期データを読み込みました',
          timestamp: DateTime.now(),
        ),
      ],
    );
  }

  int get reservedGuests => schedules
      .expand((schedule) => schedule.slots)
      .fold(0, (sum, slot) => sum + slot.reservedCount);

  int get walkInTotal => schedules
      .expand((schedule) => schedule.slots)
      .fold(0, (sum, slot) => sum + slot.walkIns);

  int get standSalesTotal => orders.fold(0, (sum, order) => sum + order.price);

  int get cashOnHandTotal =>
      accounts.fold(0, (sum, account) => sum + account.cashOnHand);

  List<String> get roomNames {
    final names = <String>{};
    for (final slot in schedules.expand((schedule) => schedule.slots)) {
      names.add(slot.roomName);
    }
    return names.toList()..sort();
  }

  int get roomCount => roomNames.length;

  void addSchedule() {
    nextScheduleNumber += 1;
    final id = 'schedule-$nextScheduleNumber';
    schedules.add(
      PlanetariumSchedule(
        id: id,
        dateLabel: '$nextScheduleNumber日目',
        slots: [
          for (final roomName in roomNames) ...[
            PlanetariumSlot(
              id: '$id-$roomName-1',
              timeLabel: '10:00',
              roomName: roomName,
              capacity: 24,
            ),
            PlanetariumSlot(
              id: '$id-$roomName-2',
              timeLabel: '11:30',
              roomName: roomName,
              capacity: 24,
            ),
          ],
        ],
      ),
    );
    log(LogCategory.planetarium, '予約日程 $nextScheduleNumber日目 を追加');
  }

  void addRoom() {
    nextRoomNumber += 1;
    final roomName = '投影機${String.fromCharCode(64 + nextRoomNumber)}';
    for (final schedule in schedules) {
      schedule.slots.add(
        PlanetariumSlot(
          id: '${schedule.id}-room-$nextRoomNumber',
          timeLabel: '14:30',
          roomName: roomName,
          capacity: 24,
        ),
      );
    }
    log(LogCategory.planetarium, '$roomName の予約枠を全日程へ追加');
  }

  void addMenuItem() {
    final item = MenuItem(
      id: 'custom-$nextMenuNumber',
      name: '追加メニュー$nextMenuNumber',
      basePrice: 300,
      priceHistory: [PriceChange(300, '追加時価格')],
      options: ['通常'],
      imagePath: '',
    );
    nextMenuNumber += 1;
    menuItems.add(item);
    log(LogCategory.stand, '${item.name} を商品に追加');
  }

  void addMenuOption(String itemId) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    final option = 'オプション${item.options.length + 1}';
    item.options.add(option);
    log(LogCategory.stand, '${item.name} に $option を追加');
  }

  void renameMenuItem(String itemId, String name) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    item.name = name;
  }

  void renameMenuOption(String itemId, int index, String name) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    if (index >= 0 && index < item.options.length) {
      item.options[index] = name;
    }
  }

  void setMenuImage(String itemId, String imagePath) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    item.imagePath = imagePath;
  }

  void setMenuPrice(String itemId, int price) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    if (item.currentPrice != price) {
      item.priceHistory.add(PriceChange(price, '管理画面で価格変更'));
    }
  }

  void discountMenuItem(String itemId) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    final nextPrice = (item.currentPrice - 50).clamp(0, 999999).toInt();
    item.priceHistory.add(PriceChange(nextPrice, '管理画面で50円値引き'));
    log(LogCategory.stand, '${item.name} を ${yen(nextPrice)} に値引き');
  }

  void raiseMenuItemPrice(String itemId) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    final nextPrice = item.currentPrice + 50;
    item.priceHistory.add(PriceChange(nextPrice, '管理画面で50円値上げ'));
    log(LogCategory.stand, '${item.name} を ${yen(nextPrice)} に値上げ');
  }

  void addReservation(String slotId) {
    final slot = findSlot(slotId);
    final partySize = slot.capacity - slot.reservedCount >= 2 ? 2 : 1;
    slot.reservations.add(
      Reservation(guestName: '予約者$nextGuestNumber', partySize: partySize),
    );
    nextGuestNumber += 1;
    log(
      LogCategory.planetarium,
      '${slot.timeLabel} ${slot.roomName} に $partySize名予約',
    );
  }

  void addWalkIn(String slotId) {
    final slot = findSlot(slotId);
    slot.walkIns += 1;
    log(LogCategory.planetarium, '${slot.timeLabel} ${slot.roomName} 当日入場 +1');
  }

  void sellItem(String itemId, {required Fulfillment fulfillment}) {
    final item = menuItems.firstWhere((entry) => entry.id == itemId);
    final order = StandOrder(
      id: 'order-${orders.length + 1}',
      itemName: item.name,
      price: item.currentPrice,
      options: [item.options.first],
      fulfillment: fulfillment,
      waitNumber: fulfillment == Fulfillment.waiting ? nextWaitNumber++ : null,
    );
    orders.add(order);
    final waitText = order.waitNumber == null
        ? '即時提供'
        : '待ち番号${order.waitNumber}';
    log(LogCategory.stand, '${item.name} ${yen(item.currentPrice)} $waitText');
  }

  void confirmOrder(List<MenuItem> items, {required Fulfillment fulfillment}) {
    if (items.isEmpty) {
      return;
    }
    final waitNumber = fulfillment == Fulfillment.waiting
        ? nextWaitNumber++
        : null;
    final total = items.fold(0, (sum, item) => sum + item.currentPrice);
    final order = StandOrder(
      id: 'order-${orders.length + 1}',
      itemName: items.map((item) => item.name).join('、'),
      price: total,
      options: items.expand((item) => item.options.take(1)).toList(),
      fulfillment: fulfillment,
      waitNumber: waitNumber,
    );
    orders.add(order);
    final waitText = waitNumber == null ? '即時提供' : '待ち番号$waitNumber';
    log(LogCategory.stand, '${order.itemName} ${yen(total)} $waitText');
  }

  void completeOrder(String orderId) {
    final order = orders.firstWhere((entry) => entry.id == orderId);
    order.completed = true;
    log(LogCategory.stand, '待ち番号${order.waitNumber} ${order.itemName} 呼出済');
  }

  void addCash(String accountId, int amount) {
    final account = accounts.firstWhere((entry) => entry.id == accountId);
    account.cashOnHand += amount;
    log(
      LogCategory.finance,
      '${account.name} 現金 ${amount >= 0 ? '+' : ''}${yen(amount)}',
    );
  }

  void toggleFinancePermission(String accountId) {
    final account = accounts.firstWhere((entry) => entry.id == accountId);
    const permission = '会計確認';
    if (account.extraPermissions.contains(permission)) {
      account.extraPermissions.remove(permission);
      log(LogCategory.permission, '${account.name} から会計確認権限を削除');
    } else {
      account.extraPermissions.add(permission);
      log(LogCategory.permission, '${account.name} に会計確認権限を付与');
    }
  }

  PlanetariumSlot findSlot(String slotId) {
    return schedules
        .expand((schedule) => schedule.slots)
        .firstWhere((slot) => slot.id == slotId);
  }

  void log(LogCategory category, String message) {
    auditLogs.add(
      AuditLog(category: category, message: message, timestamp: DateTime.now()),
    );
  }
}

class PlanetariumSchedule {
  PlanetariumSchedule({
    required this.id,
    required this.dateLabel,
    required this.slots,
  });

  final String id;
  final String dateLabel;
  final List<PlanetariumSlot> slots;
}

class PlanetariumSlot {
  PlanetariumSlot({
    required this.id,
    required this.timeLabel,
    required this.roomName,
    required this.capacity,
    this.title = '投影予定',
    this.durationMinutes = 50,
    List<Reservation>? reservations,
    this.walkIns = 0,
    this.admissionRevenue = 0,
  }) : reservations = reservations ?? [];

  final String id;
  final String timeLabel;
  final String roomName;
  final int capacity;
  String title;
  int durationMinutes;
  final List<Reservation> reservations;
  int walkIns;
  int admissionRevenue;

  int get reservedCount =>
      reservations.fold(0, (sum, reservation) => sum + reservation.partySize);

  int get startMinutes {
    final parts = timeLabel.split(':');
    final hour = int.tryParse(parts.first) ?? 0;
    final minute = parts.length > 1 ? int.tryParse(parts[1]) ?? 0 : 0;
    return hour * 60 + minute;
  }

  String get endTimeLabel {
    final end = startMinutes + durationMinutes;
    final hour = (end ~/ 60).toString().padLeft(2, '0');
    final minute = (end % 60).toString().padLeft(2, '0');
    return '$hour:$minute';
  }
}

class Reservation {
  Reservation({required this.guestName, required this.partySize});

  final String guestName;
  final int partySize;
}

class MenuItem {
  MenuItem({
    required this.id,
    required this.name,
    required this.basePrice,
    required this.priceHistory,
    required this.options,
    this.imagePath = '',
  });

  final String id;
  String name;
  final int basePrice;
  final List<PriceChange> priceHistory;
  final List<String> options;
  String imagePath;

  int get currentPrice => priceHistory.last.price;
}

class PriceChange {
  PriceChange(this.price, this.reason);

  final int price;
  final String reason;
}

class StandOrder {
  StandOrder({
    required this.id,
    required this.itemName,
    required this.price,
    required this.options,
    required this.fulfillment,
    required this.waitNumber,
    this.completed = false,
  });

  final String id;
  final String itemName;
  final int price;
  final List<String> options;
  final Fulfillment fulfillment;
  final int? waitNumber;
  bool completed;
}

class StaffAccount {
  StaffAccount({
    required this.id,
    required this.name,
    required this.role,
    required this.cashOnHand,
    required this.cashMemo,
    List<String>? extraPermissions,
  }) : extraPermissions = extraPermissions ?? [];

  final String id;
  final String name;
  final StaffRole role;
  int cashOnHand;
  final String cashMemo;
  final List<String> extraPermissions;
}

class AuditLog {
  AuditLog({
    required this.category,
    required this.message,
    required this.timestamp,
  });

  final LogCategory category;
  final String message;
  final DateTime timestamp;

  IconData get icon {
    return switch (category) {
      LogCategory.planetarium => Icons.event_seat_outlined,
      LogCategory.stand => Icons.point_of_sale_outlined,
      LogCategory.finance => Icons.payments_outlined,
      LogCategory.permission => Icons.admin_panel_settings_outlined,
      LogCategory.system => Icons.info_outline,
    };
  }

  String get timeLabel {
    final hour = timestamp.hour.toString().padLeft(2, '0');
    final minute = timestamp.minute.toString().padLeft(2, '0');
    return '$hour:$minute';
  }
}

enum Fulfillment { instant, waiting }

enum StaffRole { executive, staff, engineer }

enum LogCategory { planetarium, stand, finance, permission, system }

String yen(int value) {
  final sign = value < 0 ? '-' : '';
  return '$sign¥${value.abs()}';
}

String roleLabel(StaffRole role) {
  return switch (role) {
    StaffRole.executive => '幹部',
    StaffRole.staff => 'スタッフ',
    StaffRole.engineer => '技術者',
  };
}
