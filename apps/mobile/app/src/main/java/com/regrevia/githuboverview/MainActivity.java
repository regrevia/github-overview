package com.regrevia.githuboverview;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 一个壳：把电脑上跑的看板装进手机。
 *
 * 数据、登录、同步全在电脑那头，手机只负责显示同一份页面，
 * 所以这里不做任何 API 调用，也不保存令牌。
 */
public class MainActivity extends Activity {
  private static final String PREFS = "github-overview";
  private static final String KEY = "server";

  private WebView web;
  private LinearLayout setup;
  private SharedPreferences prefs;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    String saved = prefs.getString(KEY, "");
    if (saved.isEmpty()) {
      showSetup(getString(R.string.setup_hint));
    } else {
      load(saved);
    }
  }

  private int dp(int v) {
    return (int) (v * getResources().getDisplayMetrics().density);
  }

  private void showSetup(String hint) {
    setup = new LinearLayout(this);
    setup.setOrientation(LinearLayout.VERTICAL);
    setup.setBackgroundColor(Color.parseColor("#101114"));
    int pad = dp(24);
    setup.setPadding(pad, dp(72), pad, pad);

    TextView title = new TextView(this);
    title.setText(R.string.app_name);
    title.setTextColor(Color.parseColor("#F5F5F7"));
    title.setTextSize(20);
    setup.addView(title);

    TextView sub = new TextView(this);
    sub.setText(hint);
    sub.setTextColor(Color.parseColor("#8E8E93"));
    sub.setTextSize(13);
    LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    subLp.topMargin = dp(8);
    setup.addView(sub, subLp);

    final EditText input = new EditText(this);
    input.setSingleLine(true);
    input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    input.setTextColor(Color.parseColor("#F5F5F7"));
    input.setHintTextColor(Color.parseColor("#5A5A5F"));
    input.setTextSize(15);
    LinearLayout.LayoutParams inLp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    inLp.topMargin = dp(20);
    setup.addView(input, inLp);

    Button go = new Button(this);
    go.setText(R.string.setup_go);
    LinearLayout.LayoutParams goLp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    goLp.topMargin = dp(16);
    setup.addView(go, goLp);

    input.requestFocus();
    InputMethodManager ime = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
    if (ime != null) ime.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);

    go.setOnClickListener(v -> {
      String url = normalize(input.getText().toString());
      if (url == null) {
        input.setError(getString(R.string.setup_bad));
        return;
      }
      prefs.edit().putString(KEY, url).apply();
      load(url);
    });
    setContentView(setup);
  }

  /** 只认 http(s)，顺手补协议和去掉结尾斜杠，省得用户被格式卡住。 */
  private static String normalize(String raw) {
    String s = raw == null ? "" : raw.trim();
    if (s.isEmpty()) return null;
    if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
    try {
      Uri u = Uri.parse(s);
      if (u.getHost() == null || u.getHost().isEmpty()) return null;
    } catch (Exception e) {
      return null;
    }
    while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
    return s;
  }

  private void load(String url) {
    if (web == null) {
      web = new WebView(this);
      web.setBackgroundColor(Color.parseColor("#101114"));
      WebSettings s = web.getSettings();
      s.setJavaScriptEnabled(true);
      s.setDomStorageEnabled(true);
      s.setLoadWithOverviewMode(true);
      s.setUseWideViewPort(true);
      s.setSupportZoom(false);
      web.setWebViewClient(new WebViewClient() {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
          // 授权这类跳出看板的链接交给手机浏览器，登录态留在他自己的浏览器里
          Uri u = req.getUrl();
          String host = u.getHost() == null ? "" : u.getHost();
          String base = Uri.parse(prefs.getString(KEY, "")).getHost();
          // 站内跳转留在壳里，授权/外链交给手机浏览器
          if (base != null && host.equals(base)) return false;
          try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
            return true;
          } catch (Exception ignored) {
            return false;
          }
        }
      });
      setContentView(web);
    }
    web.loadUrl(url);
  }

  @Override
  public boolean onCreateOptionsMenu(Menu menu) {
    menu.add(0, 1, 0, R.string.setup_change);
    return true;
  }

  @Override
  public boolean onOptionsItemSelected(MenuItem item) {
    if (item.getItemId() == 1) {
      prefs.edit().putString(KEY, "").apply();
      if (web != null) {
        web.destroy();
        web = null;
      }
      showSetup(getString(R.string.setup_hint));
      return true;
    }
    return super.onOptionsItemSelected(item);
  }

  @Override
  public void onBackPressed() {
    if (web != null && web.canGoBack()) {
      web.goBack();
      return;
    }
    super.onBackPressed();
  }
}
