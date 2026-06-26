<?php
/**
 * WordPress configuration for the Acurast Cargo deployment.
 *
 * DB credentials come from the deployment env. WP_HOME / WP_SITEURL are derived
 * from the incoming request so the site works at whatever public tunnel URL
 * (https://<clientId>.<DOMAIN_SUFFIX>:8443) it ends up on, without hardcoding it.
 * Salts are appended by start.sh (fetched from api.wordpress.org).
 */

define('DB_NAME', getenv('WORDPRESS_DB_NAME') ?: 'wordpress');
define('DB_USER', getenv('WORDPRESS_DB_USER') ?: 'wordpress');
define('DB_PASSWORD', getenv('WORDPRESS_DB_PASSWORD') ?: 'wordpress');
define('DB_HOST', '127.0.0.1');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

// TLS is terminated at the Acurast relay; Apache sees plain HTTP behind it.
// Trust the forwarded proto so WordPress builds https:// URLs for assets.
if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
    $_SERVER['HTTPS'] = ($_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') ? 'on' : 'off';
}
$proto = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
if (!empty($_SERVER['HTTP_HOST'])) {
    define('WP_HOME', $proto . '://' . $_SERVER['HTTP_HOST']);
    define('WP_SITEURL', WP_HOME);
}

$table_prefix = 'wp_';

define('WP_DEBUG', false);

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

require_once ABSPATH . 'wp-settings.php';
