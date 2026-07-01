import 'dart:convert';
import 'dart:io';

class ApiTransport {
  Future<ApiTransportResponse> request(
    Uri uri, {
    required String method,
    Map<String, String>? headers,
    Object? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      request.headers.contentType = ContentType.json;
      headers?.forEach(request.headers.set);
      if (body != null) {
        request.write(jsonEncode(body));
      }
      final response = await request.close();
      final text = await response.transform(utf8.decoder).join();
      return ApiTransportResponse(response.statusCode, text);
    } finally {
      client.close();
    }
  }
}

class ApiTransportResponse {
  ApiTransportResponse(this.statusCode, this.body);

  final int statusCode;
  final String body;
}
