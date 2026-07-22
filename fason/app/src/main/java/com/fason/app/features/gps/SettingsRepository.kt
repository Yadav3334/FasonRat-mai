package com.fason.app.features.gps

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

class SettingsRepository(private val context: Context) {
    companion object {
        val SERVER_URL_KEY = stringPreferencesKey("server_url")
        val IS_TRACKING_KEY = booleanPreferencesKey("is_tracking")
        val TRACKING_INTERVAL_SECONDS_KEY = intPreferencesKey("tracking_interval_seconds")
    }

    val serverUrl: Flow<String> = context.dataStore.data
        .map { preferences ->
            preferences[SERVER_URL_KEY] ?: "https://example.com/api/location"
        }

    val isTracking: Flow<Boolean> = context.dataStore.data
        .map { preferences ->
            preferences[IS_TRACKING_KEY] ?: false
        }

    val trackingIntervalSeconds: Flow<Int> = context.dataStore.data
        .map { preferences ->
            preferences[TRACKING_INTERVAL_SECONDS_KEY] ?: 10
        }

    suspend fun saveServerUrl(url: String) {
        context.dataStore.edit { preferences ->
            preferences[SERVER_URL_KEY] = url
        }
    }

    suspend fun setTracking(isTracking: Boolean) {
        context.dataStore.edit { preferences ->
            preferences[IS_TRACKING_KEY] = isTracking
        }
    }

    suspend fun setTrackingIntervalSeconds(seconds: Int) {
        context.dataStore.edit { preferences ->
            preferences[TRACKING_INTERVAL_SECONDS_KEY] = seconds.coerceIn(1, 3600)
        }
    }
}
