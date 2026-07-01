import 'dart:async';

import 'package:flutter/material.dart';

import 'api_client.dart';

void main() {
  runApp(const FestivalDxApp());
}

class FestivalDxApp extends StatelessWidget {
  const FestivalDxApp({super.key, this.api});

  final ApiClient? api;

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
        ),
        cardTheme: CardThemeData(
          color: Colors.white,
          elevation: 1.5,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
        useMaterial3: true,
      ),
      home: LoginGate(api: api ?? ApiClient()),
    );
  }
}

class LoginGate extends StatefulWidget {
  const LoginGate({super.key, required this.api});

  final ApiClient api;

  @override
  State<LoginGate> createState() => _LoginGateState();
}

class _LoginGateState extends State<LoginGate> {
  Map<String, dynamic>? user;

  @override
  Widget build(BuildContext context) {
    if (user == null) {
      return LoginPage(
        api: widget.api,
        onLoggedIn: (value) => setState(() => user = value),
      );
    }
    return HomePage(
      api: widget.api,
      user: user!,
      onLogout: () async {
        await widget.api.logout();
        setState(() => user = null);
      },
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.api, required this.onLoggedIn});

  final ApiClient api;
  final ValueChanged<Map<String, dynamic>> onLoggedIn;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final loginIdController = TextEditingController(text: 'admin');
  final passwordController = TextEditingController(text: 'admin1234');
  String? error;
  bool loading = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SizedBox(
          width: 420,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '天文学研究部 城北祭DX',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 20),
                  TextField(
                    controller: loginIdController,
                    decoration: const InputDecoration(
                      labelText: 'ログインID',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: passwordController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'パスワード',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (error != null)
                    Text(
                      error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: loading ? null : _login,
                    icon: loading
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.login),
                    label: const Text('ログイン'),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '接続先: ${widget.api.baseUrl}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _login() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final response = await widget.api.login(
        loginIdController.text,
        passwordController.text,
      );
      widget.onLoggedIn(response['user'] as Map<String, dynamic>);
    } on ApiException catch (exception) {
      setState(() => error = exception.message);
    } finally {
      if (mounted) {
        setState(() => loading = false);
      }
    }
  }
}

class HomePage extends StatefulWidget {
  const HomePage({
    super.key,
    required this.api,
    required this.user,
    required this.onLogout,
  });

  final ApiClient api;
  final Map<String, dynamic> user;
  final VoidCallback onLogout;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      DashboardPage(api: widget.api),
      OrdersPage(api: widget.api),
      PlanetariumPage(api: widget.api),
      PlanetariumAdminPage(api: widget.api),
      StandAdminPage(api: widget.api),
      FinancePage(api: widget.api),
      SettingsPage(api: widget.api, user: widget.user),
      LogsPage(api: widget.api),
    ];
    return Scaffold(
      appBar: AppBar(
        title: const Text('天文学研究部 城北祭DX'),
        actions: [
          Center(child: Text(widget.user['display_name']?.toString() ?? '')),
          IconButton(
            tooltip: 'ログアウト',
            onPressed: widget.onLogout,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: selectedIndex,
            onDestinationSelected: (value) =>
                setState(() => selectedIndex = value),
            labelType: NavigationRailLabelType.all,
            destinations: const [
              NavigationRailDestination(
                icon: Icon(Icons.dashboard_outlined),
                selectedIcon: Icon(Icons.dashboard),
                label: Text('概要'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.point_of_sale_outlined),
                selectedIcon: Icon(Icons.point_of_sale),
                label: Text('屋台'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.event_seat_outlined),
                selectedIcon: Icon(Icons.event_seat),
                label: Text('予約'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.event_note_outlined),
                selectedIcon: Icon(Icons.event_note),
                label: Text('予約管理'),
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
              NavigationRailDestination(
                icon: Icon(Icons.history_outlined),
                selectedIcon: Icon(Icons.history),
                label: Text('ログ'),
              ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: pages[selectedIndex]),
        ],
      ),
    );
  }
}

class DashboardPage extends StatelessWidget {
  const DashboardPage({super.key, required this.api});

  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '運用概要',
      child: FutureBuilder<List<List<dynamic>>>(
        future: Future.wait([api.orders(), api.slots(), api.logs()]),
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          final orders = snapshot.data![0];
          final slots = snapshot.data![1];
          final logs = snapshot.data![2];
          final sales = orders.fold<int>(
            0,
            (sum, item) => sum + (item['total_amount'] as num).toInt(),
          );
          final reserved = slots.fold<int>(
            0,
            (sum, item) => sum + (item['reserved_count'] as num).toInt(),
          );
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  MetricTile(
                    label: '予約人数',
                    value: '$reserved',
                    icon: Icons.confirmation_number,
                  ),
                  MetricTile(
                    label: '注文件数',
                    value: '${orders.length}',
                    icon: Icons.receipt_long,
                  ),
                  MetricTile(
                    label: '屋台売上',
                    value: yen(sales),
                    icon: Icons.payments,
                  ),
                  MetricTile(
                    label: 'ログ',
                    value: '${logs.length}',
                    icon: Icons.history,
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Expanded(child: LogList(logs: logs.take(20).toList())),
            ],
          );
        },
      ),
    );
  }
}

class OrdersPage extends StatefulWidget {
  const OrdersPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<OrdersPage> createState() => _OrdersPageState();
}

class CartLine {
  CartLine({
    required this.menuItemId,
    required this.name,
    required this.unitPrice,
    required this.isImmediate,
    required this.optionIds,
    required this.optionNames,
  });

  final String menuItemId;
  final String name;
  final int unitPrice;
  final bool isImmediate;
  final List<String> optionIds;
  final List<String> optionNames;
}

class _OrdersPageState extends State<OrdersPage> {
  late Future<void> future = _load();
  List<dynamic> menu = [];
  final cart = <CartLine>[];
  final selectedOptions = <String, Set<String>>{};
  bool selectedImmediate = true;
  bool submittingOrder = false;
  String? message;

  Future<void> _load() async {
    final items = await widget.api.menuItems(includeUnavailable: true);
    menu = items
        .where(
          (item) => item['is_hidden'] != true && item['sale_stopped'] != true,
        )
        .toList();
    for (final item in menu) {
      selectedOptions.putIfAbsent(item['id'].toString(), () => <String>{});
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '屋台注文',
      child: FutureBuilder<void>(
        future: future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          final total = cart.fold<int>(0, (sum, line) => sum + line.unitPrice);
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SegmentedButton<bool>(
                      segments: const [
                        ButtonSegment(
                          value: true,
                          icon: Icon(Icons.flash_on),
                          label: Text('即時'),
                        ),
                        ButtonSegment(
                          value: false,
                          icon: Icon(Icons.timer_outlined),
                          label: Text('待ち'),
                        ),
                      ],
                      selected: {selectedImmediate},
                      onSelectionChanged: (values) {
                        setState(() => selectedImmediate = values.first);
                      },
                    ),
                    const SizedBox(height: 12),
                    Expanded(
                      child: GridView.builder(
                        gridDelegate:
                            const SliverGridDelegateWithMaxCrossAxisExtent(
                              maxCrossAxisExtent: 280,
                              mainAxisExtent: 240,
                              crossAxisSpacing: 12,
                              mainAxisSpacing: 12,
                            ),
                        itemCount: menu.length,
                        itemBuilder: (context, index) {
                          final item = menu[index] as Map<String, dynamic>;
                          final id = item['id'].toString();
                          final remaining = item['remaining_count'] == null
                              ? null
                              : (item['remaining_count'] as num).toInt();
                          final count = cart
                              .where((line) => line.menuItemId == id)
                              .length;
                          final isSoldOut = isMenuItemSoldOut(item);
                          final reachedCartLimit =
                              remaining != null && count >= remaining;
                          final canAdd = !isSoldOut && !reachedCartLimit;
                          return Card(
                            child: InkWell(
                              borderRadius: BorderRadius.circular(8),
                              onTap: canAdd
                                  ? () => setState(() {
                                      cart.add(_cartLineFromItem(item));
                                    })
                                  : null,
                              child: Padding(
                                padding: const EdgeInsets.all(16),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Icon(
                                          selectedImmediate
                                              ? Icons.flash_on
                                              : Icons.timer_outlined,
                                        ),
                                        const Spacer(),
                                        if (count > 0)
                                          CircleAvatar(
                                            radius: 16,
                                            child: Text('$count'),
                                          ),
                                      ],
                                    ),
                                    const Spacer(),
                                    Text(
                                      item['name'].toString(),
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium
                                          ?.copyWith(
                                            color: isSoldOut
                                                ? Colors.red
                                                : reachedCartLimit
                                                ? Colors.orange
                                                : null,
                                          ),
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      isSoldOut
                                          ? '売り切れ'
                                          : reachedCartLimit
                                          ? 'カート上限'
                                          : yen(_itemUnitPrice(item)),
                                      style: Theme.of(context)
                                          .textTheme
                                          .headlineSmall
                                          ?.copyWith(
                                            color: isSoldOut || reachedCartLimit
                                                ? isSoldOut
                                                      ? Colors.red
                                                      : Colors.orange
                                                : null,
                                            fontWeight:
                                                isSoldOut || reachedCartLimit
                                                ? FontWeight.w800
                                                : null,
                                          ),
                                    ),
                                    if (remaining != null)
                                      Text(
                                        '残り $remaining',
                                        style: Theme.of(
                                          context,
                                        ).textTheme.labelLarge,
                                      ),
                                    const SizedBox(height: 8),
                                    Wrap(
                                      spacing: 6,
                                      runSpacing: 4,
                                      children: [
                                        for (final option
                                            in item['options'] as List<dynamic>)
                                          FilterChip(
                                            label: Text(
                                              '${option['name']} +${yen((option['price_delta'] as num).toInt())}',
                                            ),
                                            selected: selectedOptions[id]!
                                                .contains(option['id']),
                                            onSelected: (value) {
                                              setState(() {
                                                if (value) {
                                                  selectedOptions[id]!.add(
                                                    option['id'].toString(),
                                                  );
                                                } else {
                                                  selectedOptions[id]!.remove(
                                                    option['id'].toString(),
                                                  );
                                                }
                                              });
                                            },
                                          ),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    const SizedBox(height: 12),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                total == 0
                                    ? '商品をタップして注文に追加'
                                    : '合計 ${yen(total)} / ${_cartCount()}点',
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                            ),
                            TextButton.icon(
                              onPressed: total == 0
                                  ? null
                                  : () => setState(cart.clear),
                              icon: const Icon(Icons.delete_outline),
                              label: const Text('取消'),
                            ),
                            const SizedBox(width: 8),
                            FilledButton.icon(
                              onPressed: total == 0 || submittingOrder
                                  ? null
                                  : () => _submitOrder(total),
                              icon: submittingOrder
                                  ? const SizedBox(
                                      width: 18,
                                      height: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(Icons.check),
                              label: Text(submittingOrder ? '送信中' : '確定'),
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (message != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        message!,
                        style: TextStyle(
                          color: message!.contains('登録しました')
                              ? Theme.of(context).colorScheme.primary
                              : Theme.of(context).colorScheme.error,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final item in menu)
                          if (cart.any(
                            (line) => line.menuItemId == item['id'].toString(),
                          ))
                            Chip(
                              label: Text(
                                '${item['name']} x${cart.where((line) => line.menuItemId == item['id'].toString()).length}',
                              ),
                              onDeleted: () => setState(
                                () => cart.removeWhere(
                                  (line) =>
                                      line.menuItemId == item['id'].toString(),
                                ),
                              ),
                            ),
                        for (var index = 0; index < cart.length; index++)
                          InputChip(
                            label: Text(
                              '${cart[index].name} ${cart[index].optionNames.isEmpty ? '通常' : cart[index].optionNames.join(' / ')} ${cart[index].isImmediate ? '即時' : '待ち'}',
                            ),
                            onDeleted: () =>
                                setState(() => cart.removeAt(index)),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 16),
              SizedBox(
                width: 280,
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '注文履歴',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        const Text('履歴と呼び出し操作は別ウィンドウで確認します。'),
                        const SizedBox(height: 16),
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            onPressed: () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  fullscreenDialog: true,
                                  builder: (_) =>
                                      OrderHistoryPage(api: widget.api),
                                ),
                              );
                            },
                            icon: const Icon(Icons.receipt_long),
                            label: const Text('注文履歴を開く'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  int _cartCount() {
    return cart.length;
  }

  int _itemUnitPrice(dynamic item) {
    final id = item['id'].toString();
    final basePrice = (item['price'] as num).toInt();
    final optionTotal = (item['options'] as List<dynamic>).fold<int>(0, (
      sum,
      option,
    ) {
      if (selectedOptions[id]?.contains(option['id'].toString()) != true) {
        return sum;
      }
      return sum + (option['price_delta'] as num).toInt();
    });
    return basePrice + optionTotal;
  }

  CartLine _cartLineFromItem(Map<String, dynamic> item) {
    final id = item['id'].toString();
    final selected = selectedOptions[id] ?? <String>{};
    final selectedOptionRows = (item['options'] as List<dynamic>)
        .where((option) => selected.contains(option['id'].toString()))
        .toList();
    return CartLine(
      menuItemId: id,
      name: item['name'].toString(),
      unitPrice: _itemUnitPrice(item),
      isImmediate: selectedImmediate,
      optionIds: selectedOptionRows
          .map((option) => option['id'].toString())
          .toList(),
      optionNames: selectedOptionRows
          .map((option) => option['name'].toString())
          .toList(),
    );
  }

  Future<void> _submitOrder(int total) async {
    setState(() {
      submittingOrder = true;
      message = null;
    });
    final items = [
      for (final line in cart)
        {
          'menu_item_id': line.menuItemId,
          'quantity': 1,
          'is_immediate': line.isImmediate,
          'option_ids': line.optionIds,
        },
    ];
    try {
      final response = await widget.api.createOrder(
        paidAmount: total,
        items: items,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        cart.clear();
        message = '注文 ${response['order_no']} を登録しました';
        future = _load();
      });
    } on ApiException catch (exception) {
      if (!mounted) {
        return;
      }
      setState(() {
        message = exception.message;
        future = _load();
      });
    } finally {
      if (mounted) {
        setState(() => submittingOrder = false);
      }
    }
  }
}

class OrderHistoryPage extends StatefulWidget {
  const OrderHistoryPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<OrderHistoryPage> createState() => _OrderHistoryPageState();
}

class _OrderHistoryPageState extends State<OrderHistoryPage> {
  late Future<List<dynamic>> future = widget.api.orders();

  void _reload() {
    setState(() {
      future = widget.api.orders();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('注文履歴'),
        actions: [
          IconButton(
            tooltip: '再読み込み',
            onPressed: _reload,
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: '閉じる',
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.close),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: FutureBuilder<List<dynamic>>(
          future: future,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError) {
              return ErrorPanel(error: snapshot.error.toString());
            }
            return OrdersList(
              api: widget.api,
              orders: snapshot.data!,
              onChanged: _reload,
            );
          },
        ),
      ),
    );
  }
}

class OrdersList extends StatelessWidget {
  const OrdersList({
    super.key,
    required this.api,
    required this.orders,
    required this.onChanged,
  });

  final ApiClient api;
  final List<dynamic> orders;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListView.separated(
        padding: const EdgeInsets.all(8),
        itemCount: orders.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final order = orders[index] as Map<String, dynamic>;
          final items = (order['items'] as List<dynamic>);
          final orderStatus = order['status'].toString();
          final orderColor = statusTextColor(orderStatus);
          return ExpansionTile(
            title: Text(
              '${order['order_no']}  ${yen((order['total_amount'] as num).toInt())}',
              style: TextStyle(color: orderColor, fontWeight: FontWeight.w700),
            ),
            subtitle: Text(
              '状態: ${statusLabel(orderStatus)} / 呼出: ${order['call_no'] ?? '-'}',
              style: TextStyle(color: orderColor),
            ),
            children: [
              for (final item in items) ...[
                Builder(
                  builder: (context) {
                    final itemStatus = item['status'].toString();
                    final itemColor = statusTextColor(itemStatus);
                    return ListTile(
                      dense: true,
                      title: Text(
                        '${item['item_name']} x${item['quantity']}',
                        style: TextStyle(
                          color: itemColor,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      subtitle: Align(
                        alignment: Alignment.centerLeft,
                        child: Chip(
                          backgroundColor: statusColor(itemStatus),
                          label: Text(
                            statusLabel(itemStatus),
                            style: TextStyle(
                              color: statusTextColor(itemStatus),
                            ),
                          ),
                        ),
                      ),
                      trailing: item['status'] == 'served'
                          ? Icon(Icons.done, color: itemColor)
                          : Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (item['status'] == 'ready')
                                  FilledButton.icon(
                                    onPressed: () async {
                                      await api.updateOrderItemStatus(
                                        order['id'].toString(),
                                        item['id'].toString(),
                                        'called',
                                      );
                                      onChanged();
                                    },
                                    icon: const Icon(
                                      Icons.notifications_active,
                                    ),
                                    label: const Text('呼び出し'),
                                  ),
                                if (item['status'] == 'ready')
                                  const SizedBox(width: 8),
                                FilledButton.icon(
                                  onPressed: () async {
                                    await api.updateOrderItemStatus(
                                      order['id'].toString(),
                                      item['id'].toString(),
                                      'served',
                                    );
                                    onChanged();
                                  },
                                  icon: const Icon(Icons.done),
                                  label: const Text('提供'),
                                ),
                              ],
                            ),
                    );
                  },
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class PlanetariumPage extends StatefulWidget {
  const PlanetariumPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<PlanetariumPage> createState() => _PlanetariumPageState();
}

class _PlanetariumPageState extends State<PlanetariumPage> {
  late Future<List<dynamic>> future = widget.api.slots();
  final nameController = TextEditingController(text: '予約者');
  final contactController = TextEditingController();
  int peopleCount = 1;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: 'プラネタリウム予約',
      child: FutureBuilder<List<dynamic>>(
        future: future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          final slots = snapshot.data!;
          return ListView(
            children: [
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: nameController,
                      decoration: const InputDecoration(
                        labelText: '名前',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: TextField(
                      controller: contactController,
                      decoration: const InputDecoration(
                        labelText: 'メール/LINE/Apple ID',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  DropdownButton<int>(
                    value: peopleCount,
                    items: [1, 2, 3, 4, 5, 6]
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text('$value名'),
                          ),
                        )
                        .toList(),
                    onChanged: (value) =>
                        setState(() => peopleCount = value ?? 1),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              for (final slot in slots)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.event_seat),
                    title: Text(slot['title'].toString()),
                    subtitle: Text(
                      '${formatTime(slot['starts_at'].toString())}  ${slot['reserved_count']}/${slot['capacity']}名',
                    ),
                    trailing: FilledButton.icon(
                      onPressed:
                          (slot['reserved_count'] as num) >=
                              (slot['capacity'] as num)
                          ? null
                          : () => _reserve(slot['id'].toString()),
                      icon: const Icon(Icons.person_add_alt_1),
                      label: const Text('予約'),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _reserve(String slotId) async {
    await widget.api.createReservation(
      slotId: slotId,
      name: nameController.text,
      contactType: 'line',
      contactValue: contactController.text.isEmpty
          ? 'line-${DateTime.now().millisecondsSinceEpoch}'
          : contactController.text,
      peopleCount: peopleCount,
    );
    setState(() {
      future = widget.api.slots();
    });
  }
}

class PlanetariumAdminPage extends StatelessWidget {
  const PlanetariumAdminPage({super.key, required this.api});

  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: 'プラネタリウム管理',
      child: FutureBuilder<List<dynamic>>(
        future: api.slots(),
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          final slots = snapshot.data!;
          final capacity = slots.fold<int>(
            0,
            (sum, slot) => sum + (slot['capacity'] as num).toInt(),
          );
          final reserved = slots.fold<int>(
            0,
            (sum, slot) => sum + (slot['reserved_count'] as num).toInt(),
          );
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: ListView(
                  children: [
                    AdminPanel(
                      color: const Color(0xffe0f2fe),
                      icon: Icons.event_available_outlined,
                      title: '予約枠',
                      subtitle: 'FastAPI サーバー上の予約枠を表示します。',
                      trailing: Text(
                        '${slots.length}枠',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      action: const SizedBox.shrink(),
                    ),
                    const SizedBox(height: 12),
                    for (final slot in slots)
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.schedule),
                          title: Text(slot['title'].toString()),
                          subtitle: Text(
                            formatTime(slot['starts_at'].toString()),
                          ),
                          trailing: Text(
                            '${slot['reserved_count']}/${slot['capacity']}名',
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 16),
              SizedBox(
                width: 320,
                child: Column(
                  children: [
                    MetricTile(
                      label: '予約人数',
                      value: '$reserved',
                      icon: Icons.groups_outlined,
                    ),
                    MetricTile(
                      label: '総定員',
                      value: '$capacity',
                      icon: Icons.event_seat_outlined,
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class StandAdminPage extends StatefulWidget {
  const StandAdminPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<StandAdminPage> createState() => _StandAdminPageState();
}

class _StandAdminPageState extends State<StandAdminPage> {
  late Future<List<List<dynamic>>> future = _load();

  Future<List<List<dynamic>>> _load() {
    return Future.wait([
      widget.api.menuItems(includeUnavailable: true),
      widget.api.orders(),
    ]);
  }

  void _reload() {
    setState(() {
      future = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '屋台管理',
      child: FutureBuilder<List<List<dynamic>>>(
        future: future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          final menu = snapshot.data![0] as List<dynamic>;
          final orders = snapshot.data![1] as List<dynamic>;
          final orderCount = orders.length;
          final paidTotal = orders.fold<int>(
            0,
            (sum, order) => sum + (order['paid_amount'] as num).toInt(),
          );
          final servedCount = orders
              .where((order) => order['status'].toString() == 'served')
              .length;
          final salesTotal = orders.fold<int>(
            0,
            (sum, order) => sum + (order['total_amount'] as num).toInt(),
          );
          final allSaleStopped =
              menu.isNotEmpty &&
              menu.every((item) => item['sale_stopped'] == true);
          return ListView(
            children: [
              Card(
                child: SwitchListTile(
                  value: allSaleStopped,
                  title: const Text('全商品を一括で発売中止'),
                  subtitle: const Text('オンにすると全商品が注文画面に出なくなります。'),
                  secondary: const Icon(Icons.pause_circle_outline),
                  onChanged: (value) async {
                    await widget.api.updateAllMenuSaleStopped(value);
                    _reload();
                  },
                ),
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  MetricTile(
                    label: '注文件数',
                    value: '$orderCount件',
                    icon: Icons.receipt_long,
                  ),
                  MetricTile(
                    label: '金額受領済',
                    value: yen(paidTotal),
                    icon: Icons.price_check,
                  ),
                  MetricTile(
                    label: '受取済',
                    value: '$servedCount件',
                    icon: Icons.task_alt,
                  ),
                  MetricTile(
                    label: '売り上げ',
                    value: yen(salesTotal),
                    icon: Icons.payments,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AdminPanel(
                      color: const Color(0xfffff7ed),
                      icon: Icons.restaurant_menu,
                      title: '販売メニュー',
                      subtitle: '商品の追加、削除、価格、オプション追加料金を管理します。',
                      trailing: Text(
                        '${menu.length}品',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      action: FilledButton.icon(
                        onPressed: () => _showMenuItemDialog(),
                        icon: const Icon(Icons.add),
                        label: const Text('商品を追加'),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  FilledButton.tonalIcon(
                    onPressed: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          fullscreenDialog: true,
                          builder: (_) => OrderDisplayPage(api: widget.api),
                        ),
                      );
                    },
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('待ち番号ディスプレイ'),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              for (final item in menu)
                Card(
                  child: ExpansionTile(
                    leading: const Icon(Icons.fastfood_outlined),
                    title: Text(item['name'].toString()),
                    subtitle: Text(
                      '基本 ${yen((item['price'] as num).toInt())} / ${item['default_immediate'] == true ? '即時' : '待ち'} / ${menuItemStatusText(item)} / ${item['remaining_count'] == null ? '残数管理なし' : '残り ${item['remaining_count']}'}',
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          tooltip: '商品を編集',
                          onPressed: () => _showMenuItemDialog(item: item),
                          icon: const Icon(Icons.edit),
                        ),
                        const SizedBox(width: 8),
                        IconButton(
                          tooltip: '商品を削除',
                          onPressed: () async {
                            await widget.api.deleteMenuItem(
                              item['id'].toString(),
                            );
                            _reload();
                          },
                          icon: const Icon(Icons.delete_outline),
                        ),
                      ],
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                        child: Wrap(
                          spacing: 12,
                          runSpacing: 8,
                          children: [
                            FilterChip(
                              label: const Text('発売中止'),
                              selected: item['sale_stopped'] == true,
                              onSelected: (value) =>
                                  _updateItemStatus(item, saleStopped: value),
                            ),
                            FilterChip(
                              label: const Text('売り切れ'),
                              selected: item['sold_out'] == true,
                              onSelected: (value) =>
                                  _updateItemStatus(item, soldOut: value),
                            ),
                            FilterChip(
                              label: const Text('非表示'),
                              selected: item['is_hidden'] == true,
                              onSelected: (value) =>
                                  _updateItemStatus(item, isHidden: value),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: FilledButton.tonalIcon(
                            onPressed: () => _showOptionDialog(item),
                            icon: const Icon(Icons.add),
                            label: const Text('オプションを追加'),
                          ),
                        ),
                      ),
                      for (final option in item['options'] as List<dynamic>)
                        ListTile(
                          dense: true,
                          leading: const Icon(Icons.tune),
                          title: Text(option['name'].toString()),
                          subtitle: Text(
                            '+${yen((option['price_delta'] as num).toInt())}',
                          ),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                tooltip: 'オプションを編集',
                                onPressed: () =>
                                    _showOptionDialog(item, option: option),
                                icon: const Icon(Icons.edit),
                              ),
                              const SizedBox(width: 8),
                              IconButton(
                                tooltip: 'オプションを削除',
                                onPressed: () async {
                                  await widget.api.deleteMenuOption(
                                    itemId: item['id'].toString(),
                                    optionId: option['id'].toString(),
                                  );
                                  _reload();
                                },
                                icon: const Icon(Icons.delete_outline),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _showMenuItemDialog({dynamic item}) async {
    final nameController = TextEditingController(
      text: item?['name']?.toString() ?? '',
    );
    final priceController = TextEditingController(
      text: item == null ? '300' : (item['price'] as num).toInt().toString(),
    );
    final remainingController = TextEditingController(
      text: item?['remaining_count'] == null
          ? ''
          : item['remaining_count'].toString(),
    );
    var defaultImmediate = item?['default_immediate'] == true;
    var saleStopped = item?['sale_stopped'] == true;
    var soldOut = item?['sold_out'] == true;
    var isHidden = item?['is_hidden'] == true;
    if (item == null) {
      defaultImmediate = true;
    }
    final result = await showDialog<bool>(
      context: context,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setLocalState) {
            return AlertDialog(
              title: Text(item == null ? '商品を追加' : '商品を編集'),
              content: SizedBox(
                width: 420,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      controller: nameController,
                      decoration: const InputDecoration(
                        labelText: '商品名',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: priceController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: '価格',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: remainingController,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: '残り数（空欄なら管理なし）',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    SwitchListTile(
                      value: defaultImmediate,
                      title: const Text('標準は即時提供'),
                      onChanged: (value) =>
                          setLocalState(() => defaultImmediate = value),
                    ),
                    SwitchListTile(
                      value: saleStopped,
                      title: const Text('発売中止'),
                      onChanged: (value) =>
                          setLocalState(() => saleStopped = value),
                    ),
                    SwitchListTile(
                      value: soldOut,
                      title: const Text('売り切れ'),
                      onChanged: (value) =>
                          setLocalState(() => soldOut = value),
                    ),
                    SwitchListTile(
                      value: isHidden,
                      title: const Text('非表示'),
                      onChanged: (value) =>
                          setLocalState(() => isHidden = value),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('キャンセル'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('保存'),
                ),
              ],
            );
          },
        );
      },
    );
    if (result != true) {
      return;
    }
    final price = int.tryParse(priceController.text) ?? 0;
    final remainingCount = remainingController.text.trim().isEmpty
        ? null
        : int.tryParse(remainingController.text);
    if (item == null) {
      await widget.api.createMenuItem(
        name: nameController.text,
        price: price,
        defaultImmediate: defaultImmediate,
        saleStopped: saleStopped,
        soldOut: soldOut,
        isHidden: isHidden,
        remainingCount: remainingCount,
      );
    } else {
      await widget.api.updateMenuItem(
        id: item['id'].toString(),
        name: nameController.text,
        price: price,
        defaultImmediate: defaultImmediate,
        saleStopped: saleStopped,
        soldOut: soldOut,
        isHidden: isHidden,
        remainingCount: remainingCount,
      );
    }
    _reload();
  }

  Future<void> _showOptionDialog(dynamic item, {dynamic option}) async {
    final nameController = TextEditingController(
      text: option?['name']?.toString() ?? '',
    );
    final priceController = TextEditingController(
      text: option == null
          ? '100'
          : (option['price_delta'] as num).toInt().toString(),
    );
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(option == null ? 'オプションを追加' : 'オプションを編集'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameController,
                decoration: const InputDecoration(
                  labelText: 'オプション名',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: priceController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: '追加料金',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (result != true) {
      return;
    }
    final priceDelta = int.tryParse(priceController.text) ?? 0;
    if (option == null) {
      await widget.api.createMenuOption(
        itemId: item['id'].toString(),
        name: nameController.text,
        priceDelta: priceDelta,
      );
    } else {
      await widget.api.updateMenuOption(
        itemId: item['id'].toString(),
        optionId: option['id'].toString(),
        name: nameController.text,
        priceDelta: priceDelta,
      );
    }
    _reload();
  }

  Future<void> _updateItemStatus(
    dynamic item, {
    bool? saleStopped,
    bool? soldOut,
    bool? isHidden,
  }) async {
    await widget.api.updateMenuItem(
      id: item['id'].toString(),
      name: item['name'].toString(),
      price: (item['price'] as num).toInt(),
      defaultImmediate: item['default_immediate'] == true,
      saleStopped: saleStopped ?? (item['sale_stopped'] == true),
      soldOut: soldOut ?? (item['sold_out'] == true),
      isHidden: isHidden ?? (item['is_hidden'] == true),
      remainingCount: item['remaining_count'] == null
          ? null
          : (item['remaining_count'] as num).toInt(),
    );
    _reload();
  }
}

class OrderDisplayPage extends StatefulWidget {
  const OrderDisplayPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<OrderDisplayPage> createState() => _OrderDisplayPageState();
}

class _OrderDisplayPageState extends State<OrderDisplayPage> {
  late Future<List<dynamic>> future = widget.api.orders();
  Timer? timer;

  @override
  void initState() {
    super.initState();
    timer = Timer.periodic(const Duration(seconds: 8), (_) {
      if (mounted) {
        setState(() {
          future = widget.api.orders();
        });
      }
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xff101418),
      body: SafeArea(
        child: FutureBuilder<List<dynamic>>(
          future: future,
          builder: (context, snapshot) {
            final orders = snapshot.data ?? [];
            final preparing = orders
                .where(
                  (order) =>
                      order['status'] == 'ready' ||
                      order['status'] == 'preparing',
                )
                .take(12)
                .toList();
            final called = orders
                .where((order) => order['status'] == 'called')
                .take(12)
                .toList();
            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
                  child: Row(
                    children: [
                      Text(
                        '注文状況',
                        style: Theme.of(context).textTheme.headlineMedium
                            ?.copyWith(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                            ),
                      ),
                      const Spacer(),
                      IconButton.filledTonal(
                        tooltip: '閉じる',
                        onPressed: () => Navigator.of(context).pop(),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Row(
                    children: [
                      Expanded(
                        child: DisplayColumn(title: '準備中', orders: preparing),
                      ),
                      Container(width: 2, color: Colors.white24),
                      Expanded(
                        child: DisplayColumn(title: '受け取り待ち', orders: called),
                      ),
                    ],
                  ),
                ),
                SizedBox(
                  height: 112,
                  child: Row(
                    children: [
                      Expanded(
                        child: Container(
                          height: double.infinity,
                          padding: const EdgeInsets.symmetric(horizontal: 32),
                          color: const Color(0xff1f2937),
                          alignment: Alignment.centerLeft,
                          child: Text(
                            '現在の待ち時間: 約10分',
                            style: Theme.of(context).textTheme.displayMedium
                                ?.copyWith(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                ),
                          ),
                        ),
                      ),
                      Expanded(
                        child: Container(
                          height: double.infinity,
                          color: const Color(0xff111827),
                          alignment: Alignment.center,
                          child: const MarqueeBanner(
                            text: '呼び出してから10分以上経過して番号が無い方は声をかけてください　　',
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class DisplayColumn extends StatelessWidget {
  const DisplayColumn({super.key, required this.title, required this.orders});

  final String title;
  final List<dynamic> orders;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 18),
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border.all(color: Colors.white, width: 3),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              title,
              style: Theme.of(context).textTheme.displayMedium?.copyWith(
                color: Colors.black,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 28),
          Expanded(
            child: Wrap(
              spacing: 18,
              runSpacing: 18,
              children: [
                for (final order in orders)
                  Container(
                    width: 190,
                    height: 118,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        displayOrderNo(order),
                        style: Theme.of(context).textTheme.displayLarge
                            ?.copyWith(
                              color: Colors.black,
                              fontWeight: FontWeight.w900,
                            ),
                      ),
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

class MarqueeBanner extends StatefulWidget {
  const MarqueeBanner({super.key, required this.text});

  final String text;

  @override
  State<MarqueeBanner> createState() => _MarqueeBannerState();
}

class _MarqueeBannerState extends State<MarqueeBanner>
    with SingleTickerProviderStateMixin {
  late final AnimationController controller;

  @override
  void initState() {
    super.initState();
    controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 12),
    )..repeat();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: AnimatedBuilder(
        animation: controller,
        builder: (context, child) {
          final width = MediaQuery.sizeOf(context).width / 2;
          return Transform.translate(
            offset: Offset(width - controller.value * width * 2, 0),
            child: child,
          );
        },
        child: Text(
          widget.text,
          maxLines: 1,
          style: Theme.of(context).textTheme.displaySmall?.copyWith(
            color: Colors.white,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class FinancePage extends StatefulWidget {
  const FinancePage({super.key, required this.api});

  final ApiClient api;

  @override
  State<FinancePage> createState() => _FinancePageState();
}

class _FinancePageState extends State<FinancePage> {
  late Future<Map<String, dynamic>> future = widget.api.salesSummary();
  String selectedType = 'category';
  String selectedKey = 'total';

  void _select(String type, String key) {
    setState(() {
      selectedType = type;
      selectedKey = key;
    });
  }

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '売上金管理',
      child: FutureBuilder<Map<String, dynamic>>(
        future: future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          final summary = snapshot.data!;
          final categories = summary['categories'] as Map<String, dynamic>;
          final members = summary['members'] as List<dynamic>;
          final logs = _filteredLogs(summary['logs'] as List<dynamic>);
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 360,
                child: ListView(
                  children: [
                    Text(
                      'カテゴリ別売上',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    SelectableSalesTile(
                      label: '屋台総売上',
                      value: yen((categories['stall'] as num).toInt()),
                      icon: Icons.storefront,
                      selected:
                          selectedType == 'category' && selectedKey == 'stall',
                      onTap: () => _select('category', 'stall'),
                    ),
                    SelectableSalesTile(
                      label: 'プラネタリウム総売上',
                      value: yen((categories['planetarium'] as num).toInt()),
                      icon: Icons.event_seat,
                      selected:
                          selectedType == 'category' &&
                          selectedKey == 'planetarium',
                      onTap: () => _select('category', 'planetarium'),
                    ),
                    SelectableSalesTile(
                      label: '総売上',
                      value: yen((categories['total'] as num).toInt()),
                      icon: Icons.payments,
                      selected:
                          selectedType == 'category' && selectedKey == 'total',
                      onTap: () => _select('category', 'total'),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      '部員別売上',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    for (final member in members)
                      SelectableSalesTile(
                        label: member['display_name'].toString(),
                        value: yen((member['total'] as num).toInt()),
                        icon: Icons.person,
                        selected:
                            selectedType == 'member' &&
                            selectedKey ==
                                (member['user_id'] ?? 'unknown').toString(),
                        onTap: () => _select(
                          'member',
                          (member['user_id'] ?? 'unknown').toString(),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Row(
                          children: [
                            Text(
                              '売上詳細',
                              style: Theme.of(context).textTheme.titleLarge,
                            ),
                            const Spacer(),
                            IconButton(
                              tooltip: '再読み込み',
                              onPressed: () {
                                setState(() {
                                  future = widget.api.salesSummary();
                                });
                              },
                              icon: const Icon(Icons.refresh),
                            ),
                          ],
                        ),
                      ),
                      const Divider(height: 1),
                      Expanded(
                        child: logs.isEmpty
                            ? const Center(child: Text('該当する売上はありません'))
                            : ListView.separated(
                                itemCount: logs.length,
                                separatorBuilder: (_, _) =>
                                    const Divider(height: 1),
                                itemBuilder: (context, index) {
                                  final log =
                                      logs[index] as Map<String, dynamic>;
                                  return ListTile(
                                    leading: Icon(
                                      log['department'] == 'stall'
                                          ? Icons.storefront
                                          : Icons.event_seat,
                                    ),
                                    title: Text(log['message'].toString()),
                                    subtitle: Row(
                                      children: [
                                        Text(log['document_no'].toString()),
                                        const SizedBox(width: 8),
                                        StatusBadge(
                                          status: log['status'].toString(),
                                        ),
                                      ],
                                    ),
                                    trailing: Text(
                                      yen((log['amount'] as num).toInt()),
                                      style: Theme.of(
                                        context,
                                      ).textTheme.titleMedium,
                                    ),
                                  );
                                },
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  List<dynamic> _filteredLogs(List<dynamic> logs) {
    if (selectedType == 'category') {
      if (selectedKey == 'total') {
        return logs;
      }
      return logs
          .where(
            (log) => (log as Map<String, dynamic>)['department'] == selectedKey,
          )
          .toList();
    }
    return logs.where((log) {
      final item = log as Map<String, dynamic>;
      return (item['user_id'] ?? 'unknown').toString() == selectedKey;
    }).toList();
  }
}

class SelectableSalesTile extends StatelessWidget {
  const SelectableSalesTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final String value;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: selected ? colorScheme.primaryContainer : colorScheme.surface,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              border: Border.all(
                color: selected
                    ? colorScheme.primary
                    : colorScheme.outlineVariant,
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Icon(icon, color: selected ? colorScheme.primary : null),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.titleMedium,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  value,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
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

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.api, required this.user});

  final ApiClient api;
  final Map<String, dynamic> user;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late Future<Map<String, dynamic>> accessFuture = widget.api.accessControl();
  final loginIdController = TextEditingController();
  final displayNameController = TextEditingController();
  final passwordController = TextEditingController();
  final selectedPermissions = <String>{};
  String? accountMessage;
  bool creatingUser = false;

  @override
  Widget build(BuildContext context) {
    final permissions = (widget.user['permissions'] as List<dynamic>? ?? [])
        .map((permission) => permission.toString())
        .toList();
    return AppPage(
      title: '設定',
      child: DefaultTabController(
        length: 3,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const TabBar(
              tabs: [
                Tab(icon: Icon(Icons.person_add_alt_1), text: 'アカウント作成'),
                Tab(icon: Icon(Icons.verified_user_outlined), text: '現在の権限'),
                Tab(icon: Icon(Icons.dns_outlined), text: '接続'),
              ],
            ),
            const SizedBox(height: 12),
            Expanded(
              child: TabBarView(
                children: [
                  _buildAccountCreateTab(),
                  ListView(
                    children: [
                      AdminPanel(
                        color: const Color(0xffeef2ff),
                        icon: Icons.admin_panel_settings_outlined,
                        title: 'ログイン中ユーザー',
                        subtitle:
                            '${widget.user['login_id']} / ${widget.user['role']}',
                        trailing: Text(
                          '${permissions.length}権限',
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        action: const SizedBox.shrink(),
                      ),
                      const SizedBox(height: 16),
                      Text('権限', style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 8),
                      for (final permission in permissions)
                        Card(
                          child: ListTile(
                            leading: const Icon(Icons.verified_user_outlined),
                            title: Text(permission),
                          ),
                        ),
                    ],
                  ),
                  ListView(
                    children: [
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.dns_outlined),
                          title: const Text('API 接続先'),
                          subtitle: Text(widget.api.baseUrl),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildAccountCreateTab() {
    return FutureBuilder<Map<String, dynamic>>(
      future: accessFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return ErrorPanel(error: snapshot.error.toString());
        }
        final permissions = (snapshot.data!['permissions'] as List<dynamic>)
            .map((permission) => permission as Map<String, dynamic>)
            .toList();
        return ListView(
          children: [
            AdminPanel(
              color: const Color(0xffecfdf5),
              icon: Icons.person_add_alt_1,
              title: 'アカウント作成',
              subtitle: 'ログインID、パスワード、権限を指定してスタッフ用アカウントを作成します。',
              trailing: Text(
                '${selectedPermissions.length}権限',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              action: FilledButton.icon(
                onPressed: creatingUser ? null : _createAccount,
                icon: creatingUser
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.add),
                label: const Text('作成'),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: loginIdController,
                    decoration: const InputDecoration(
                      labelText: 'ログインID',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: displayNameController,
                    decoration: const InputDecoration(
                      labelText: '表示名',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: passwordController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'パスワード（8文字以上）',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Text('権限', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final permission in permissions)
                  FilterChip(
                    label: Text(permission['code'].toString()),
                    selected: selectedPermissions.contains(permission['code']),
                    onSelected: (value) {
                      setState(() {
                        final code = permission['code'].toString();
                        if (value) {
                          selectedPermissions.add(code);
                        } else {
                          selectedPermissions.remove(code);
                        }
                      });
                    },
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [
                OutlinedButton(
                  onPressed: () {
                    setState(() {
                      selectedPermissions
                        ..clear()
                        ..addAll(permissions.map((p) => p['code'].toString()));
                    });
                  },
                  child: const Text('全権限'),
                ),
                OutlinedButton(
                  onPressed: () {
                    setState(() {
                      selectedPermissions
                        ..clear()
                        ..addAll([
                          'orders:read',
                          'orders:write',
                          'orders:serve',
                          'reservations:read',
                          'reservations:write',
                        ]);
                    });
                  },
                  child: const Text('スタッフ標準'),
                ),
                OutlinedButton(
                  onPressed: () => setState(selectedPermissions.clear),
                  child: const Text('クリア'),
                ),
              ],
            ),
            if (accountMessage != null) ...[
              const SizedBox(height: 12),
              Text(accountMessage!),
            ],
          ],
        );
      },
    );
  }

  Future<void> _createAccount() async {
    setState(() {
      creatingUser = true;
      accountMessage = null;
    });
    try {
      final created = await widget.api.createUser(
        loginId: loginIdController.text.trim(),
        password: passwordController.text,
        displayName: displayNameController.text.trim(),
        permissionCodes: selectedPermissions.toList()..sort(),
      );
      setState(() {
        accountMessage = '${created['login_id']} を作成しました';
        loginIdController.clear();
        displayNameController.clear();
        passwordController.clear();
        selectedPermissions.clear();
        accessFuture = widget.api.accessControl();
      });
    } on ApiException catch (exception) {
      setState(() => accountMessage = exception.message);
    } finally {
      if (mounted) {
        setState(() => creatingUser = false);
      }
    }
  }

  @override
  void dispose() {
    loginIdController.dispose();
    displayNameController.dispose();
    passwordController.dispose();
    super.dispose();
  }
}

class LogsPage extends StatelessWidget {
  const LogsPage({super.key, required this.api});

  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return AppPage(
      title: '操作ログ',
      child: FutureBuilder<List<dynamic>>(
        future: api.logs(),
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorPanel(error: snapshot.error.toString());
          }
          return LogList(logs: snapshot.data!);
        },
      ),
    );
  }
}

class LogList extends StatelessWidget {
  const LogList({super.key, required this.logs});

  final List<dynamic> logs;

  @override
  Widget build(BuildContext context) {
    if (logs.isEmpty) {
      return const Center(child: Text('ログはまだありません'));
    }
    return ListView.separated(
      itemCount: logs.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final log = logs[index] as Map<String, dynamic>;
        return ListTile(
          leading: const Icon(Icons.history),
          title: Text(log['action'].toString()),
          subtitle: Text('${log['created_at']}  ${log['display_name'] ?? ''}'),
        );
      },
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

class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final background = statusColor(status);
    final textColor = switch (status) {
      'called' => const Color(0xff0f172a),
      'served' => const Color(0xff052e16),
      _ => const Color(0xff111827),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        statusLabel(status),
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
          color: textColor,
          fontWeight: FontWeight.w700,
        ),
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

class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, required this.error});

  final String error;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(
            error,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ),
      ),
    );
  }
}

String yen(int value) => '¥$value';

String statusLabel(String status) {
  return switch (status) {
    'preparing' => '準備中',
    'ready' => '準備中',
    'called' => '呼出中',
    'served' => '受取済',
    'cancelled' => 'キャンセル',
    _ => status,
  };
}

Color statusColor(String status) {
  return switch (status) {
    'preparing' => const Color(0xffe5e7eb),
    'ready' => const Color(0xffe5e7eb),
    'called' => const Color(0xff93c5fd),
    'served' => const Color(0xff86efac),
    _ => const Color(0xfff3f4f6),
  };
}

Color statusTextColor(String status) {
  return switch (status) {
    'preparing' => const Color(0xff4b5563),
    'ready' => const Color(0xff4b5563),
    'called' => const Color(0xff1d4ed8),
    'served' => const Color(0xff15803d),
    'cancelled' => const Color(0xffb91c1c),
    _ => const Color(0xff111827),
  };
}

String menuItemStatusText(dynamic item) {
  final labels = <String>[];
  if (item['sale_stopped'] == true) {
    labels.add('発売中止');
  }
  if (isMenuItemSoldOut(item)) {
    labels.add('売り切れ');
  }
  if (item['is_hidden'] == true) {
    labels.add('非表示');
  }
  return labels.isEmpty ? '販売中' : labels.join(' / ');
}

bool isMenuItemSoldOut(dynamic item) {
  final remaining = item['remaining_count'] == null
      ? null
      : (item['remaining_count'] as num).toInt();
  return item['sold_out'] == true || remaining == 0;
}

String displayOrderNo(dynamic order) {
  final callNo = order['call_no'];
  if (callNo != null && callNo.toString().isNotEmpty) {
    return callNo.toString();
  }
  return order['order_no']?.toString() ?? '-';
}

String formatTime(String value) {
  final parsed = DateTime.tryParse(value);
  if (parsed == null) {
    return value;
  }
  final month = parsed.month.toString().padLeft(2, '0');
  final day = parsed.day.toString().padLeft(2, '0');
  final hour = parsed.hour.toString().padLeft(2, '0');
  final minute = parsed.minute.toString().padLeft(2, '0');
  return '$month/$day $hour:$minute';
}
