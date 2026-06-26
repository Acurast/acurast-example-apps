<?php
/**
 * WordPress configuration for the Acurast Cargo deployment.
 *
 * DB credentials come from the deployment env. WP_HOME / WP_SITEURL are derived
 * from the incoming request so the site works at whatever public tunnel URL
 * (https://<clientId>.<DOMAIN_SUFFIX>) it ends up on, without hardcoding it.
 * Salts are appended by start.sh (fetched from api.wordpress.org).
 */

define('DB_NAME', getenv('WORDPRESS_DB_NAME') ?: 'wordpress');
define('DB_USER', getenv('WORDPRESS_DB_USER') ?: 'wordpress');
define('DB_PASSWORD', getenv('WORDPRESS_DB_PASSWORD') ?: 'wordpress');
define('DB_HOST', '127.0.0.1');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

// TLS is terminated at the Acurast relay; Apache sees plain HTTP behind it, and
// the relay does not set X-Forwarded-Proto. The public side of the tunnel is
// ALWAYS https, so assume https unless the relay explicitly says otherwise —
// otherwise WordPress builds http:// URLs and redirects break (302 to http://).
$xfp = !empty($_SERVER['HTTP_X_FORWARDED_PROTO']) ? $_SERVER['HTTP_X_FORWARDED_PROTO'] : '';
$proto = ($xfp === 'http') ? 'http' : 'https';
$_SERVER['HTTPS'] = ($proto === 'https') ? 'on' : 'off';
if (!empty($_SERVER['HTTP_HOST'])) {
    define('WP_HOME', $proto . '://' . $_SERVER['HTTP_HOST']);
    define('WP_SITEURL', WP_HOME);
}

// Secret keys/salts, generated once by start.sh into a persistent file outside
// the docroot (independent of any network fetch and stable for the deployment,
// so auth cookies validate — missing/unstable salts cause a wp-login loop).
if (is_readable('/usr/local/etc/wp-salts.php')) {
    require '/usr/local/etc/wp-salts.php';
}

$table_prefix = 'wp_';

define('WP_DEBUG', false);

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

require_once ABSPATH . 'wp-settings.php';
