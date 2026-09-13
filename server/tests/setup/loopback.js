import { Test } from 'supertest';

// supertest starts each server with listen(0), which binds the IPv6 wildcard,
// and then connects to 127.0.0.1. On macOS that bind is allowed even when
// another program already holds the same port on 127.0.0.1 alone, and the
// request then reaches that program instead of the app under test. It shows up
// rarely, once in several thousand requests, as a response with a status or
// body Sift never sends.
//
// Binding to 127.0.0.1 instead cannot work here: with an address given, Node
// binds a tick later, and supertest reads the port straight after calling
// listen. So the server keeps binding the wildcard and the request goes to
// ::1. A program listening on IPv4 loopback alone cannot answer that, and one
// holding the port on IPv6 would have made the bind fail, so the OS would not
// have handed that port out.
const serverAddress = Test.prototype.serverAddress;

Test.prototype.serverAddress = function overIpv6Loopback(app, path) {
  const url = serverAddress.call(this, app, path);
  // Where IPv6 is unavailable the bind falls back to IPv4, and so does the URL.
  if (app.address()?.family !== 'IPv6') return url;
  return url.replace('://127.0.0.1:', '://[::1]:');
};
