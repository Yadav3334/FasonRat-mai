package com.fason.app.features.screen

import android.content.Context
import android.media.AudioManager
import android.graphics.PointF
import android.util.Log
import com.fason.app.core.FasonApp
import com.fason.app.core.Protocol
import org.json.JSONObject

class RemoteActionController {

    fun handleAction(message: String) {
        try {
            val json = JSONObject(message)
            when (json.optString(Protocol.KEY_ACTION)) {
                Protocol.ACTION_TAP -> {
                    val point = readPoint(json, "x", "y") ?: return
                    RemoteControlService.instance?.performTap(point.x, point.y)
                }
                Protocol.ACTION_SWIPE -> {
                    val start = readPoint(json, "startX", "startY") ?: return
                    val end = readPoint(json, "endX", "endY") ?: return
                    val duration = json.optLong("duration", 300)
                    RemoteControlService.instance?.performSwipe(start.x, start.y, end.x, end.y, duration)
                }
                Protocol.ACTION_KEY -> {
                    RemoteControlService.instance?.performKey(json.optString("keyCode"))
                }
                Protocol.ACTION_TEXT -> {
                    RemoteControlService.instance?.performText(json.optString("text"))
                }
                Protocol.ACTION_GESTURE -> {
                    val rawPoints = json.optJSONArray("points") ?: return
                    val points = ArrayList<PointF>(minOf(rawPoints.length(), 256))
                    for (index in 0 until minOf(rawPoints.length(), 256)) {
                        val point = rawPoints.optJSONObject(index) ?: continue
                        readPoint(point, "x", "y")?.let(points::add)
                    }
                    if (points.isNotEmpty()) {
                        RemoteControlService.instance?.performGesture(
                            points,
                            json.optLong("duration", 300).coerceIn(1, 60_000),
                        )
                    }
                }
                Protocol.ACTION_TOUCH_START -> readPoint(json, "x", "y")?.let {
                    RemoteControlService.instance?.beginContinuousTouch(it.x, it.y)
                }
                Protocol.ACTION_TOUCH_MOVE -> readPoint(json, "x", "y")?.let {
                    RemoteControlService.instance?.moveContinuousTouch(it.x, it.y)
                }
                Protocol.ACTION_TOUCH_END -> readPoint(json, "x", "y")?.let {
                    RemoteControlService.instance?.endContinuousTouch(it.x, it.y)
                }
                Protocol.ACTION_VOLUME -> adjustVolume(json.optString("direction"))
                else -> {
                    Log.w("RemoteActionController", "Unknown action type: ${json.optString("action")}")
                }
            }
        } catch (e: Exception) {
            Log.e("RemoteActionController", "Error parsing remote action", e)
        }
    }

    private fun readPoint(json: JSONObject, xKey: String, yKey: String): PointF? {
        val rawX = json.optDouble(xKey, Double.NaN)
        val rawY = json.optDouble(yKey, Double.NaN)
        if (!rawX.isFinite() || !rawY.isFinite()) return null
        val width = ScreenCaptureService.screenWidth
        val height = ScreenCaptureService.screenHeight
        if (width < 2 || height < 2) return null
        return PointF(
            rawX.toFloat().coerceIn(0f, (width - 1).toFloat()),
            rawY.toFloat().coerceIn(0f, (height - 1).toFloat()),
        )
    }

    private fun adjustVolume(direction: String) {
        val audio = FasonApp.getContext().getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        val adjustment = when (direction.lowercase()) {
            "up" -> AudioManager.ADJUST_RAISE
            "down" -> AudioManager.ADJUST_LOWER
            "mute" -> AudioManager.ADJUST_TOGGLE_MUTE
            else -> return
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, adjustment, 0)
        } else {
            @Suppress("DEPRECATION")
            audio.adjustSuggestedStreamVolume(adjustment, AudioManager.STREAM_MUSIC, 0)
        }
    }
}
