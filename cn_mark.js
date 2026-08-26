// 搭配 http_meta_geo_dns.js 使用

if (!$server._geo) {
  $server.name = '!失败! ' + $server.name;
} else if ($server._geo.includes('www.google.cn')) {
  $server.name = '!送中! ' + $server.name;
}
