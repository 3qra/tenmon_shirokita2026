import 'dart:convert';
import 'dart:html' as html;

class ApiTransport {
  Future<ApiTransportResponse> request(
    Uri uri, {
    required String method,
    Map<String, String>? headers,
    Object? body,
  }) async {
    final response = await html.HttpRequest.request(
      uri.toString(),
      method: method,
      requestHeaders: {'Content-Type': 'application/json', ...?headers},
      sendData: body == null ? null : jsonEncode(body),
    );
    return ApiTransportResponse(
      response.status ?? 0,
      response.responseText ?? '',
    );
  }
}

class ApiTransportResponse {
  ApiTransportResponse(this.statusCode, this.body);

  final int statusCode;
  final String body;
}
