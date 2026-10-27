<?php
// Sudoku 1v1 — backend. Ogni partita è un file JSON in data/games/.
// Nessun database richiesto: basta PHP 7.4+ su hosting condiviso (es. Netsons).
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const DATA_DIR = __DIR__ . '/data/games';
const ID_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const DIFFS = ['facile', 'media', 'difficile', 'esperta', 'master'];
const MAX_AGE_DAYS = 14;

function out(array $a, int $code = 200): void {
  http_response_code($code);
  echo json_encode($a, JSON_UNESCAPED_UNICODE);
  exit;
}
function fail(string $err, int $code = 400): void { out(['ok' => false, 'error' => $err], $code); }
function now_ms(): int { return (int) round(microtime(true) * 1000); }
function th(string $token): string { return hash('sha256', $token); }

function new_id(): string {
  $s = '';
  $n = strlen(ID_ABC);
  for ($i = 0; $i < 10; $i++) $s .= ID_ABC[random_int(0, $n - 1)];
  return $s;
}
function valid_id($id): bool { return is_string($id) && preg_match('/^[a-z2-9]{10}$/', $id) === 1; }
function valid_token($t): bool { return is_string($t) && preg_match('/^[a-f0-9]{32,64}$/', $t) === 1; }

function clean_name($n): string {
  $n = trim((string) preg_replace('/\s+/u', ' ', strip_tags((string) $n)));
  if ($n === '') $n = 'Giocatore';
  return function_exists('mb_substr') ? mb_substr($n, 0, 16) : substr($n, 0, 16);
}

// The solution must be a full valid grid and the puzzle a subset of it.
function valid_board($puzzle, $solution): bool {
  if (!is_string($puzzle) || !is_string($solution)) return false;
  if (!preg_match('/^[0-9]{81}$/', $puzzle) || !preg_match('/^[1-9]{81}$/', $solution)) return false;
  for ($i = 0; $i < 81; $i++) {
    if ($puzzle[$i] !== '0' && $puzzle[$i] !== $solution[$i]) return false;
  }
  for ($k = 0; $k < 9; $k++) {
    $row = $col = $box = [];
    for ($j = 0; $j < 9; $j++) {
      $row[] = $solution[$k * 9 + $j];
      $col[] = $solution[$j * 9 + $k];
      $box[] = $solution[(intdiv($k, 3) * 3 + intdiv($j, 3)) * 9 + ($k % 3) * 3 + ($j % 3)];
    }
    foreach ([$row, $col, $box] as $set) if (count(array_unique($set)) !== 9) return false;
  }
  return true;
}

function new_player(string $token, string $name, string $puzzle): array {
  return [
    'th' => th($token), 'name' => $name, 'vals' => $puzzle, 'notes' => str_repeat('00', 81),
    'err' => 0, 'out' => false, 'doneAt' => null, 'filled' => 0, 'updated' => now_ms(),
  ];
}

function new_game(array $base, string $token, string $name): array {
  return [
    'id' => '', 'created' => now_ms(), 'diff' => $base['diff'], 'maxErr' => $base['maxErr'],
    'puzzle' => $base['puzzle'], 'solution' => $base['solution'],
    'status' => 'waiting', 'startAt' => null, 'next' => null, 'winner' => null, 'reason' => null,
    'players' => [new_player($token, $name, $base['puzzle'])],
  ];
}

function ensure_dir(): void {
  if (!is_dir(DATA_DIR) && !@mkdir(DATA_DIR, 0775, true)) fail('storage', 500);
}

// Writes a brand-new game under a fresh id; returns the id.
function store_new(array $g): string {
  ensure_dir();
  for ($tries = 0; $tries < 8; $tries++) {
    $id = new_id();
    $fp = @fopen(DATA_DIR . "/$id.json", 'x');
    if (!$fp) continue;
    $g['id'] = $id;
    fwrite($fp, json_encode($g, JSON_UNESCAPED_UNICODE));
    fclose($fp);
    if (random_int(1, 50) === 1) cleanup();
    return $id;
  }
  fail('storage', 500);
  return '';
}

function cleanup(): void {
  $limit = time() - MAX_AGE_DAYS * 86400;
  foreach (glob(DATA_DIR . '/*.json') ?: [] as $f) {
    if (@filemtime($f) < $limit) @unlink($f);
  }
}

// Opens a game under an exclusive lock, runs $fn(&$g, &$changed), saves if changed.
function with_game(string $id, callable $fn) {
  $path = DATA_DIR . "/$id.json";
  if (!is_file($path)) fail('not_found', 404);
  $fp = fopen($path, 'r+');
  if (!$fp) fail('storage', 500);
  flock($fp, LOCK_EX);
  $g = json_decode((string) stream_get_contents($fp), true);
  if (!is_array($g)) { flock($fp, LOCK_UN); fclose($fp); fail('corrupt', 500); }
  $changed = false;
  $res = $fn($g, $changed);
  if ($changed) {
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($g, JSON_UNESCAPED_UNICODE));
    fflush($fp);
  }
  flock($fp, LOCK_UN);
  fclose($fp);
  return [$g, $res];
}

function player_index(array $g, string $token): int {
  $h = th($token);
  foreach ($g['players'] as $i => $p) if (hash_equals($p['th'], $h)) return $i;
  return -1;
}

function pub(array $g, ?array $p, bool $full): ?array {
  if (!$p) return null;
  $a = [
    'name' => $p['name'], 'filled' => $p['filled'], 'err' => $p['err'], 'out' => $p['out'],
    'doneMs' => ($p['doneAt'] !== null && $g['startAt']) ? $p['doneAt'] - $g['startAt'] : null,
  ];
  if ($full) { $a['vals'] = $p['vals']; $a['notes'] = $p['notes']; }
  return $a;
}

function state(array $g, int $idx): array {
  $me = $idx >= 0 ? $g['players'][$idx] : null;
  $opp = null;
  foreach ($g['players'] as $i => $p) if ($i !== $idx) { $opp = $p; break; }
  $winner = null;
  if ($g['winner'] !== null) $winner = $g['winner'] === $idx ? 'me' : 'opp';
  return [
    'ok' => true, 'id' => $g['id'], 'diff' => $g['diff'], 'maxErr' => $g['maxErr'],
    'puzzle' => $g['puzzle'], 'solution' => $g['solution'],
    'status' => $g['status'], 'startAt' => $g['startAt'], 'now' => now_ms(), 'next' => $g['next'],
    'full' => count($g['players']) >= 2, 'me' => pub($g, $me, true), 'opp' => pub($g, $opp, false),
    'winner' => $winner, 'reason' => $g['reason'],
  ];
}

/* ---------- Request ---------- */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('method', 405);
$raw = file_get_contents('php://input', false, null, 0, 20000);
$in = json_decode((string) $raw, true);
if (!is_array($in)) fail('bad_json');
$action = $_GET['action'] ?? '';
$token = $in['token'] ?? null;
if (!valid_token($token)) fail('bad_token');

if ($action === 'create') {
  $diff = in_array($in['diff'] ?? '', DIFFS, true) ? $in['diff'] : 'media';
  $maxErr = ((int) ($in['maxErr'] ?? 3)) === 0 ? 0 : 3;
  if (!valid_board($in['puzzle'] ?? null, $in['solution'] ?? null)) fail('bad_board');
  $g = new_game(['diff' => $diff, 'maxErr' => $maxErr, 'puzzle' => $in['puzzle'], 'solution' => $in['solution']], $token, clean_name($in['name'] ?? ''));
  $g['id'] = store_new($g);
  out(state($g, 0));
}

$id = $in['id'] ?? null;
if (!valid_id($id)) fail('bad_id');

if ($action === 'state') {
  [$g] = with_game($id, function (array &$g, bool &$changed) {});
  out(state($g, player_index($g, $token)));
}

if ($action === 'join') {
  $name = clean_name($in['name'] ?? '');
  [$g, $res] = with_game($id, function (array &$g, bool &$changed) use ($token, $name) {
    $idx = player_index($g, $token);
    if ($idx >= 0) return $idx;
    if (count($g['players']) >= 2) return -1;
    $g['players'][] = new_player($token, $name, $g['puzzle']);
    $g['status'] = 'playing';
    $g['startAt'] = now_ms() + 4000;
    $changed = true;
    return count($g['players']) - 1;
  });
  if ($res < 0) fail('full', 409);
  out(state($g, $res));
}

if ($action === 'move') {
  $vals = $in['vals'] ?? null;
  $notes = $in['notes'] ?? null;
  $clientErr = max(0, min(99, (int) ($in['err'] ?? 0)));
  if (!is_string($vals) || !preg_match('/^[0-9]{81}$/', $vals)) fail('bad_vals');
  if (!is_string($notes) || !preg_match('/^[0-9a-z]{162}$/', $notes)) fail('bad_notes');
  [$g, $idx] = with_game($id, function (array &$g, bool &$changed) use ($token, $vals, $notes, $clientErr) {
    $idx = player_index($g, $token);
    if ($idx < 0) return -1;
    $p = &$g['players'][$idx];
    $now = now_ms();
    if ($g['status'] !== 'playing' || $now < $g['startAt'] - 1000 || $g['winner'] !== null || $p['out'] || $p['doneAt'] !== null) return $idx;
    $pz = $g['puzzle'];
    $sol = $g['solution'];
    $newWrong = 0;
    $filled = 0;
    for ($i = 0; $i < 81; $i++) {
      if ($pz[$i] !== '0' && $vals[$i] !== $pz[$i]) return $idx; // givens can't change
      if ($pz[$i] === '0' && $vals[$i] === $sol[$i]) $filled++;
      if ($vals[$i] !== '0' && $vals[$i] !== $sol[$i] && $vals[$i] !== $p['vals'][$i]) $newWrong++;
    }
    $p['err'] = max($clientErr, $p['err'] + $newWrong);
    $p['vals'] = $vals;
    $p['notes'] = $notes;
    $p['filled'] = $filled;
    $p['updated'] = $now;
    if ($vals === $sol) $p['doneAt'] = $now;
    if ($g['maxErr'] > 0 && $p['err'] >= $g['maxErr']) $p['out'] = true;
    if ($p['doneAt'] !== null) { $g['winner'] = $idx; $g['reason'] = 'done'; $g['status'] = 'done'; }
    elseif ($p['out']) { $g['winner'] = 1 - $idx; $g['reason'] = 'err'; $g['status'] = 'done'; }
    $changed = true;
    return $idx;
  });
  if ($idx < 0) fail('not_player', 403);
  out(state($g, $idx));
}

if ($action === 'rematch') {
  if (!valid_board($in['puzzle'] ?? null, $in['solution'] ?? null)) fail('bad_board');
  $name = clean_name($in['name'] ?? '');
  [, $next] = with_game($id, function (array &$g, bool &$changed) use ($token, $in, $name) {
    if (player_index($g, $token) < 0) return '';
    if ($g['next']) return $g['next'];
    $ng = new_game(['diff' => $g['diff'], 'maxErr' => $g['maxErr'], 'puzzle' => $in['puzzle'], 'solution' => $in['solution']], $token, $name);
    $g['next'] = store_new($ng);
    $changed = true;
    return $g['next'];
  });
  if ($next === '') fail('not_player', 403);
  out(['ok' => true, 'next' => $next]);
}

fail('unknown_action', 404);
