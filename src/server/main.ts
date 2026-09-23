import { createServer } from 'node:http';

// M0 placeholder: proves the server runs under Node's type stripping. The
// registry, project routes, request checks, and static serving arrive in M1
// (DESIGN.md, "v1 plan").

const HOST = '127.0.0.1';
const port = Number(process.env.RADAR_PORT ?? 4747);

const server = createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', error => {
  console.error(`Radar could not listen on ${HOST}:${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`Radar listening on http://${HOST}:${port}/`);
});
