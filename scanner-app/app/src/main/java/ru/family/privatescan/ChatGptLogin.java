package ru.family.privatescan;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.SocketTimeoutException;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Open-source Sign in with ChatGPT (SIWC), dynamic OAuth client + PKCE.
 * No API key or client secret. Tokens persist only locally, AndroidKeyStore AES-GCM.
 * Access is gated on verified JWKS signature, issuer, audience, expiry, nonce and granted scopes.
 */
public final class ChatGptLogin {
    public interface Callback {
        void onSuccess(String identity);
        void onError(String message);
        default void onProgress(String message) {}
    }
    private static final String PREF = "ps_siwc_v1";
    private static final String KS_ALIAS = "PrivateScanSiwcOAUTH_v1";
    private static final String AUTH = "https://auth.openai.com/api/accounts/authorize";
    private static final String TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
    private static final String RESOURCE = "https://api.openai.com/v1";
    private static final String REQ_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    private final Context app;
    private final SharedPreferences preferences;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final SecureRandom secureRandom = new SecureRandom();

    public ChatGptLogin(Context context) {
        app = context.getApplicationContext();
        preferences = app.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public boolean connected() {
        try {
            JSONObject c = loadCredentials();
            return c != null && c.optString("refresh_token").length() > 5
                    && c.optString("scope").contains("chatgpt.tokens.use.direct");
        } catch (Exception e) { return false; }
    }

    public String accountLabel() {
        try {
            JSONObject credentials = loadCredentials();
            return credentials == null ? "Не подключён" : credentials.optString("email", "ChatGPT подключён");
        } catch (Exception e) { return "Не подключён"; }
    }

    public void login(Activity activity, Callback callback) {
        pool.execute(() -> {
            activity.runOnUiThread(() -> callback.onProgress("Готовлю защищённую OAuth-сессию…"));
            try {
                JSONObject saved = loadCredentials();
                String priorId = saved != null ? saved.optString("client_id", "") : "";
                boolean existing = priorId.startsWith("oaiapp_");
                String clientId = existing ? priorId : "dynamic_agent_client";
                String host = preferences.getString("host_id", null);
                if (host == null) {
                    host = "urn:uuid:" + UUID.randomUUID().toString();
                    preferences.edit().putString("host_id", host).commit();
                }

                byte[] verifierBytes = new byte[48]; secureRandom.nextBytes(verifierBytes);
                String verifier = Base64.encodeToString(verifierBytes,
                        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                String challenge = Base64.encodeToString(
                        MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)),
                        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                String state = randomToken(), nonce = randomToken();
                try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
                    server.setSoTimeout(90_000);
                    String callbackUri = "http://127.0.0.1:" + server.getLocalPort() + "/auth/callback";
                    StringBuilder q = new StringBuilder(AUTH).append('?');
                    add(q, "client_id", clientId);
                    if (!existing) add(q, "agent_name_hint", "PrivateScan");
                    add(q, "ext_agent_host_id", host);
                    if (existing && saved != null) {
                        String idToken = saved.optString("id_token");
                        if (!idToken.isEmpty()) add(q, "id_token_hint", idToken);
                    }
                    add(q, "response_type", "code");
                    add(q, "redirect_uri", callbackUri);
                    add(q, "scope", REQ_SCOPES);
                    add(q, "resource", RESOURCE);
                    add(q, "state", state);
                    add(q, "nonce", nonce);
                    add(q, "code_challenge_method", "S256");
                    add(q, "code_challenge", challenge);
                    String url = q.substring(0, q.length() - 1).replace("?&", "?");
                    activity.runOnUiThread(() -> {
                        callback.onProgress("Открываю auth.openai.com. Дождитесь страницы разрешений "
                                + "PrivateScan. Простой вход на chatgpt.com ещё не подключает приложение.");
                        try {
                            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            browser.addCategory(Intent.CATEGORY_BROWSABLE);
                            browser.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            activity.startActivity(browser);
                        } catch (Exception e) {
                            callback.onError("Не удалось открыть браузер: " + e.getMessage());
                        }
                    });

                    String path;
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(15_000);
                        BufferedReader input = new BufferedReader(
                                new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        String request = input.readLine();
                        if (request == null || !request.startsWith("GET /auth/callback?"))
                            throw new IllegalStateException("Неверный адрес возврата OAuth");
                        path = request.split(" ")[1];
                        // Do not store, expose or log returned OAuth query parameters.
                        byte[] response = ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\n"
                                + "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
                                + "<!doctype html><meta charset='utf-8'><title>PrivateScan</title>"
                                + "<p>Авторизация обработана. Вернитесь в PrivateScan.</p>")
                                .getBytes(StandardCharsets.UTF_8);
                        socket.getOutputStream().write(response);
                        socket.getOutputStream().flush();
                    }
                    activity.runOnUiThread(() -> callback.onProgress(
                            "Браузер вернул управление; проверяю код и разрешения OpenAI…"));
                    Uri received = Uri.parse("http://127.0.0.1" + path);
                    if (!state.equals(received.getQueryParameter("state")))
                        throw new IllegalStateException("Проверка OAuth state не пройдена");
                    String denied = received.getQueryParameter("error");
                    if (denied != null) throw new IllegalStateException("Разрешение не выдано: " + denied);
                    String code = received.getQueryParameter("code");
                    if (code == null || code.isEmpty()) throw new IllegalStateException("Код авторизации не получен");
                    String issued = received.getQueryParameter("client_id");
                    if (existing) {
                        if (issued != null && !issued.equals(clientId))
                            throw new IllegalStateException("Несовпадение OAuth client_id");
                    } else {
                        if (issued == null || !issued.startsWith("oaiapp_"))
                            throw new IllegalStateException("OpenAI не вернул client_id для PrivateScan");
                        clientId = issued;
                    }

                    activity.runOnUiThread(() -> callback.onProgress("Получаю токен OpenAI…"));
                    JSONObject token = postToken("grant_type=authorization_code"
                        + "&client_id=" + enc(clientId)
                        + "&code=" + enc(code)
                        + "&code_verifier=" + enc(verifier)
                        + "&redirect_uri=" + enc(callbackUri)
                        + "&resource=" + enc(RESOURCE));
                    String scopes = token.optString("scope", "");
                    if (!hasScope(scopes, "chatgpt.tokens.use.direct")
                            || !hasScope(scopes, "resource.invoke"))
                        throw new IllegalStateException("Не разрешено использовать ChatGPT-подписку");
                    String idToken = token.optString("id_token", "");
                    JSONObject user = verifyIdToken(idToken, clientId, nonce);
                    String subject = user.getString("sub");
                    if (existing && saved != null && saved.has("sub")
                            && !saved.optString("sub").equals(subject))
                        throw new IllegalStateException("Нельзя заменить авторизованный аккаунт другим");
                    JSONObject credential = new JSONObject();
                    credential.put("client_id", clientId);
                    credential.put("sub", subject);
                    credential.put("email", user.optString("email", "ChatGPT"));
                    credential.put("scope", scopes);
                    credential.put("id_token", idToken);
                    credential.put("access_token", token.getString("access_token"));
                    credential.put("refresh_token", token.getString("refresh_token"));
                    credential.put("expires_at", System.currentTimeMillis()
                        + Math.max(60, token.optLong("expires_in", 3600) - 100) * 1000L);
                    storeCredentials(credential);
                    activity.runOnUiThread(() -> callback.onProgress("Проверка завершена, сохраняю сеанс…"));
                    String label = credential.getString("email");
                    activity.runOnUiThread(() -> callback.onSuccess(label));
                }
            } catch (SocketTimeoutException timeout) {
                activity.runOnUiThread(() -> callback.onError(
                    "За 90 секунд браузер не вернулся на http://127.0.0.1. "
                    + "Страница chatgpt.com не завершает подключение. "
                    + "Повторите вход, откройте страницу согласия auth.openai.com и вернитесь в PrivateScan. "
                    + "Если браузер меняет адрес или блокирует локальный возврат, попробуйте Chrome."));
            } catch (Exception e) {
                String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                activity.runOnUiThread(() -> callback.onError(message));
            }
        });
    }

    public synchronized String getTokenForRequest() throws Exception {
        JSONObject saved = loadCredentials();
        if (saved == null) throw new IllegalStateException("Сначала подключите ChatGPT");
        if (!hasScope(saved.optString("scope", ""), "chatgpt.tokens.use.direct"))
            throw new IllegalStateException("Доступ к подписке не разрешён");
        if (System.currentTimeMillis() + 30_000 < saved.optLong("expires_at"))
            return saved.getString("access_token");
        String form = "grant_type=refresh_token"
            + "&client_id=" + enc(saved.getString("client_id"))
            + "&refresh_token=" + enc(saved.getString("refresh_token"))
            + "&resource=" + enc(RESOURCE);
        JSONObject refreshed = postToken(form);
        saved.put("access_token", refreshed.getString("access_token"));
        saved.put("refresh_token", refreshed.getString("refresh_token"));
        saved.put("expires_at", System.currentTimeMillis() +
                Math.max(60, refreshed.optLong("expires_in", 3600) - 100) * 1000L);
        if (refreshed.has("scope")) saved.put("scope", refreshed.getString("scope"));
        if (!hasScope(saved.optString("scope", ""), "chatgpt.tokens.use.direct"))
            throw new IllegalStateException("Доступ по подписке был отозван");
        storeCredentials(saved);
        return saved.getString("access_token");
    }

    public void signOut(Activity activity, Callback callback) {
        pool.execute(() -> {
            String note = "";
            try {
                JSONObject saved = loadCredentials();
                if (saved != null && !saved.optString("refresh_token").isEmpty()) {
                    try {
                        JSONObject config = readJson("https://auth.openai.com/.well-known/openid-configuration");
                        String revocation = config.optString("revocation_endpoint", "");
                        if (revocation.startsWith("https://auth.openai.com/")) {
                            sendForm(revocation, "token=" + enc(saved.getString("refresh_token"))
                                    + "&token_type_hint=refresh_token&client_id="
                                    + enc(saved.getString("client_id")));
                        } else note = "Удалён только локальный сеанс";
                    } catch (Exception e) { note = "Удалён локальный сеанс, отзыв на сервере не подтверждён"; }
                }
            } catch (Exception e) { note = "Не удалось подтвердить отзыв токенов"; }
            preferences.edit().remove("credentials").remove("iv").apply();
            String result = note.isEmpty() ? "Сеанс ChatGPT завершён" : note;
            activity.runOnUiThread(() -> callback.onSuccess(result));
        });
    }

    private JSONObject verifyIdToken(String jwt, String clientId, String nonce) throws Exception {
        String[] parts = jwt.split("\\.");
        if (parts.length != 3) throw new IllegalStateException("Некорректный ID token");
        JSONObject header = new JSONObject(new String(decode(parts[0]), StandardCharsets.UTF_8));
        JSONObject payload = new JSONObject(new String(decode(parts[1]), StandardCharsets.UTF_8));
        if (!"RS256".equals(header.optString("alg")))
            throw new IllegalStateException("Неподдерживаемый алгоритм подписи OpenAI ID token");
        if (!"https://auth.openai.com".equals(payload.optString("iss")))
            throw new IllegalStateException("Некорректный издатель ID token");
        if (payload.optLong("exp") * 1000L <= System.currentTimeMillis())
            throw new IllegalStateException("ID token истёк");
        if (!nonce.equals(payload.optString("nonce")))
            throw new IllegalStateException("Некорректный nonce ID token");
        Object aud = payload.opt("aud");
        boolean foundAudience = clientId.equals(aud);
        if (aud instanceof JSONArray) {
            JSONArray array = (JSONArray) aud;
            for (int i = 0; i < array.length(); i++)
                if (clientId.equals(array.optString(i))) foundAudience = true;
        }
        if (!foundAudience) throw new IllegalStateException("Неправильная аудитория ID token");
        if (payload.optString("sub").length() < 5)
            throw new IllegalStateException("Некорректный идентификатор аккаунта");

        JSONObject config = readJson("https://auth.openai.com/.well-known/openid-configuration");
        String jwksUrl = config.getString("jwks_uri");
        if (!jwksUrl.startsWith("https://auth.openai.com/"))
            throw new IllegalStateException("Недоверенный адрес JWKS");
        JSONArray keys = readJson(jwksUrl).getJSONArray("keys");
        String kid = header.optString("kid", "");
        for (int i = 0; i < keys.length(); i++) {
            JSONObject jwk = keys.getJSONObject(i);
            if (!kid.equals(jwk.optString("kid"))) continue;
            if (!"RSA".equals(jwk.optString("kty"))) continue;
            BigInteger modulus = new BigInteger(1, decode(jwk.getString("n")));
            BigInteger exponent = new BigInteger(1, decode(jwk.getString("e")));
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initVerify(KeyFactory.getInstance("RSA")
                .generatePublic(new RSAPublicKeySpec(modulus, exponent)));
            sig.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            if (sig.verify(decode(parts[2]))) return payload;
        }
        throw new IllegalStateException("Подпись ID token не подтверждена");
    }

    private JSONObject readJson(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15_000); conn.setReadTimeout(20_000);
        try {
            if (conn.getResponseCode() != 200) throw new IllegalStateException("OIDC HTTP " + conn.getResponseCode());
            return new JSONObject(readLimited(conn.getInputStream(), 200_000));
        } finally { conn.disconnect(); }
    }

    private JSONObject postToken(String payload) throws Exception {
        String answer = sendForm(TOKEN, payload);
        return new JSONObject(answer);
    }

    private String sendForm(String url, String form) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(20_000); conn.setReadTimeout(25_000);
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        conn.setRequestProperty("Cache-Control", "no-store");
        try {
            try (OutputStream out = conn.getOutputStream()) {
                out.write(form.getBytes(StandardCharsets.UTF_8));
            }
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("Ошибка авторизации OpenAI HTTP " + status);
            try (InputStream in = conn.getInputStream()) { return readLimited(in, 500_000); }
        } finally { conn.disconnect(); }
    }

    private String randomToken() {
        byte[] random = new byte[32]; secureRandom.nextBytes(random);
        return Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
    private static String enc(String s) throws Exception { return URLEncoder.encode(s, "UTF-8"); }
    private static void add(StringBuilder q, String name, String value) throws Exception {
        q.append(enc(name)).append('=').append(enc(value)).append('&');
    }
    private static boolean hasScope(String value, String name) {
        for (String part : value.split(" ")) if (part.equals(name)) return true;
        return false;
    }
    private static byte[] decode(String s) {
        return Base64.decode(s, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String readLimited(InputStream in, int max) throws Exception {
        try (InputStream source = in; java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] b = new byte[8192]; int n;
            while ((n = source.read(b)) != -1) {
                if (out.size() + n > max) throw new IllegalStateException("Слишком большой ответ сервера");
                out.write(b, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KS_ALIAS))
            return ((KeyStore.SecretKeyEntry) store.getEntry(KS_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KS_ALIAS, KeyProperties.PURPOSE_ENCRYPT |
                KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    private synchronized void storeCredentials(JSONObject value) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] ciphertext = c.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        if (!preferences.edit()
                .putString("credentials", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP)).commit())
            throw new IllegalStateException("Не удалось сохранить OAuth-сеанс");
    }

    private synchronized JSONObject loadCredentials() throws Exception {
        String ciphertext = preferences.getString("credentials", null);
        String iv = preferences.getString("iv", null);
        if (ciphertext == null || iv == null) return null;
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(),
                new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        return new JSONObject(new String(
                c.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }

    public void shutdown() { pool.shutdown(); }
}
