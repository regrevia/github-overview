package com.regrevia.githuboverview;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 一个壳：看板和取数都装在 App 里，不需要电脑上先跑什么。
 *
 * 页面来自 assets/web，数据引擎来自 assets/src：填一个 GitHub 用户名就能看公开数据，
 * 账号和快照都留在这台手机上。这里不发请求、不存令牌，全在网页里做。
 */
public class MainActivity extends Activity {
  private static final String PAGE = "file:///android_asset/web/index.html";

  private WebView web;
  private FrameLayout holder;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    buildWeb();
    setContentView(inset(holder));
    web.loadUrl(PAGE);
  }

  private void buildWeb() {
    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#101114"));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    // 页面要 import 同目录下的模块，file:// 默认读不到别人的 file://
    s.setAllowFileAccess(true);
    s.setAllowContentAccess(true);
    s.setAllowFileAccessFromFileURLs(true);
    s.setAllowUniversalAccessFromFileURLs(true);
    // 页面自带 width=device-width：按设备宽度排版即可。
    // 开 useWideViewPort + loadWithOverviewMode 会把页面按 980px 排完再缩回来，
    // 缩放后的内容撑不满屏幕，WebView 底色从下面透出来就是一整块黑。
    s.setUseWideViewPort(false);
    s.setLoadWithOverviewMode(false);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setTextZoom(100);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        // 授权、看仓库这类链接交给手机浏览器，登录态留在他自己的浏览器里
        Uri u = req.getUrl();
        if ("file".equals(u.getScheme())) return false;
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, u));
          return true;
        } catch (Exception ignored) {
          return false;
        }
      }
    });
    // WebView 不认自己的 padding：网页内容照样铺满整屏，状态栏会压在最上面。
    // 套一层容器，把 insets 变成容器的 padding，WebView 跟着缩进去。
    holder = new FrameLayout(this);
    holder.setBackgroundColor(Color.parseColor("#101114"));
    holder.addView(web, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    inset(holder);
  }

  /**
   * targetSdk 35 起窗口强制铺满整屏，状态栏和手势条会直接盖在内容上。
   * 把系统栏占的位置变成内边距，页面从状态栏下面开始画，底部也不被手势条压住。
   */
  private View inset(final View v) {
    final int[] base = { v.getPaddingLeft(), v.getPaddingTop(), v.getPaddingRight(), v.getPaddingBottom() };
    v.setOnApplyWindowInsetsListener((view, insets) -> {
      int top, bottom, left, right;
      if (android.os.Build.VERSION.SDK_INT >= 30) {
        android.graphics.Insets b = insets.getInsets(
            android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
        top = b.top; bottom = b.bottom; left = b.left; right = b.right;
      } else {
        top = insets.getSystemWindowInsetTop();
        bottom = insets.getSystemWindowInsetBottom();
        left = insets.getSystemWindowInsetLeft();
        right = insets.getSystemWindowInsetRight();
      }
      view.setPadding(base[0] + left, base[1] + top, base[2] + right, base[3] + bottom);
      return insets;
    });
    v.requestApplyInsets();
    return v;
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
