import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api_transport.dart';

class ApiClient {
  ApiClient({String? baseUrl}) : baseUrl = baseUrl ?? defaultBaseUrl;

  static String get defaultBaseUrl {
    const configured = String.fromEnvironment('API_BASE_URL');
    if (configured.isNotEmpty) {
      return configured;
    }
    if (kIsWeb) {
      return 'http://localhost:8000';
    }
    if (defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:8000';
    }
    return 'http://127.0.0.1:8000';
  }

  final String baseUrl;
  final ApiTransport _transport = ApiTransport();
  String? token;
  ValueChanged<String>? onUnauthorized;

  Future<Map<String, dynamic>> login(String loginId, String password) async {
    final data = await _send<Map<String, dynamic>>(
      'POST',
      '/auth/login',
      body: {'login_id': loginId, 'password': password},
      authenticated: false,
    );
    token = data['access_token'] as String?;
    return data;
  }

  Future<void> logout() async {
    if (token == null) {
      return;
    }
    await _send<Map<String, dynamic>>('POST', '/auth/logout');
    token = null;
  }

  Future<List<dynamic>> menuItems({bool includeUnavailable = false}) =>
      _send<List<dynamic>>(
        'GET',
        includeUnavailable
            ? '/menu-items?include_unavailable=true'
            : '/menu-items',
      );

  Future<Map<String, dynamic>> accessControl() =>
      _send<Map<String, dynamic>>('GET', '/access-control');

  Future<Map<String, dynamic>> createUser({
    required String loginId,
    required String password,
    required String displayName,
    required List<String> permissionCodes,
  }) {
    return _send<Map<String, dynamic>>(
      'POST',
      '/users',
      body: {
        'login_id': loginId,
        'password': password,
        'display_name': displayName,
        'permission_codes': permissionCodes,
      },
    );
  }

  Future<Map<String, dynamic>> createMenuItem({
    required String name,
    required int price,
    required bool defaultImmediate,
    bool saleStopped = false,
    bool soldOut = false,
    bool isHidden = false,
    int? remainingCount,
  }) {
    return _send<Map<String, dynamic>>(
      'POST',
      '/menu-items',
      body: {
        'name': name,
        'price': price,
        'default_immediate': defaultImmediate,
        'sale_stopped': saleStopped,
        'sold_out': soldOut,
        'is_hidden': isHidden,
        'remaining_count': remainingCount,
      },
    );
  }

  Future<void> updateMenuItem({
    required String id,
    required String name,
    required int price,
    required bool defaultImmediate,
    bool isActive = true,
    bool saleStopped = false,
    bool soldOut = false,
    bool isHidden = false,
    int? remainingCount,
  }) async {
    await _send<Map<String, dynamic>>(
      'PATCH',
      '/menu-items/$id',
      body: {
        'name': name,
        'price': price,
        'default_immediate': defaultImmediate,
        'is_active': isActive,
        'sale_stopped': saleStopped,
        'sold_out': soldOut,
        'is_hidden': isHidden,
        'remaining_count': remainingCount,
      },
    );
  }

  Future<void> updateAllMenuSaleStopped(bool saleStopped) async {
    await _send<Map<String, dynamic>>(
      'PATCH',
      '/menu-items/bulk-status',
      body: {'sale_stopped': saleStopped},
    );
  }

  Future<void> deleteMenuItem(String id) async {
    await _send<Map<String, dynamic>>('DELETE', '/menu-items/$id');
  }

  Future<Map<String, dynamic>> createMenuOption({
    required String itemId,
    required String name,
    required int priceDelta,
  }) {
    return _send<Map<String, dynamic>>(
      'POST',
      '/menu-items/$itemId/options',
      body: {'name': name, 'price_delta': priceDelta},
    );
  }

  Future<void> updateMenuOption({
    required String itemId,
    required String optionId,
    required String name,
    required int priceDelta,
    bool isActive = true,
  }) async {
    await _send<Map<String, dynamic>>(
      'PATCH',
      '/menu-items/$itemId/options/$optionId',
      body: {'name': name, 'price_delta': priceDelta, 'is_active': isActive},
    );
  }

  Future<void> deleteMenuOption({
    required String itemId,
    required String optionId,
  }) async {
    await _send<Map<String, dynamic>>(
      'DELETE',
      '/menu-items/$itemId/options/$optionId',
    );
  }

  Future<List<dynamic>> orders() =>
      _send<List<dynamic>>('GET', '/stall/orders');

  Future<Map<String, dynamic>> salesSummary() =>
      _send<Map<String, dynamic>>('GET', '/sales/summary');

  Future<Map<String, dynamic>> createOrder({
    required int paidAmount,
    required List<Map<String, dynamic>> items,
    String paymentMethod = 'cash',
  }) {
    return _send<Map<String, dynamic>>(
      'POST',
      '/stall/orders',
      body: {
        'payment_method': paymentMethod,
        'paid_amount': paidAmount,
        'items': items,
      },
    );
  }

  Future<Map<String, dynamic>> updateOrderItemStatus(
    String orderId,
    String itemId,
    String status,
  ) {
    return _send<Map<String, dynamic>>(
      'PATCH',
      '/stall/orders/$orderId/items/$itemId/status',
      body: {'status': status},
    );
  }

  Future<List<dynamic>> slots() =>
      _send<List<dynamic>>('GET', '/planetarium/slots');

  Future<Map<String, dynamic>> createReservation({
    required String slotId,
    required String name,
    required String contactType,
    required String contactValue,
    required int peopleCount,
  }) {
    return _send<Map<String, dynamic>>(
      'POST',
      '/planetarium/reservations',
      body: {
        'slot_id': slotId,
        'name': name,
        'contact_type': contactType,
        'contact_value': contactValue,
        'people_count': peopleCount,
      },
    );
  }

  Future<List<dynamic>> logs() =>
      _send<List<dynamic>>('GET', '/operation-logs');

  Future<T> _send<T>(
    String method,
    String path, {
    Object? body,
    bool authenticated = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{};
    if (authenticated && token != null) {
      headers['Authorization'] = 'Bearer $token';
    }
    try {
      final response = await _transport.request(
        uri,
        method: method,
        headers: headers,
        body: body,
      );
      final decoded = response.body.isEmpty ? null : jsonDecode(response.body);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final detail = decoded is Map ? decoded['detail'] : null;
        final message =
            detail?.toString() ?? 'API error ${response.statusCode}';
        if (authenticated && response.statusCode == 401) {
          token = null;
          onUnauthorized?.call(message);
        }
        throw ApiException(message, statusCode: response.statusCode);
      }
      return decoded as T;
    } on FormatException {
      throw ApiException('サーバー応答を読み取れません');
    } on ApiException {
      rethrow;
    } catch (_) {
      throw ApiException('サーバーに接続できません: $baseUrl');
    }
  }
}

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}
