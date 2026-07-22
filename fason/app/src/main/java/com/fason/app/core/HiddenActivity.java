package com.fason.app.core;

import android.app.Activity;
import android.os.Bundle;

public class HiddenActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        finish();
    }
}
