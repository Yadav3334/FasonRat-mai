package com.fason.app.features.screen

import android.content.Context
import android.media.AudioManager
import android.graphics.PointF
import android.util.Log
import com.fason.app.core.FasonApp
import org.json.JSONObject

class RemoteActionController {

    fun handleAction(message: String) {
        try {
            val json = JSONObject(message)
            when (json.optString("action")) {
                "tap" -> {
                    val point = readPoint(json, "x", "y") ?: return
                    RemoteControlService.instance?.performTap(point.x, point.y)
                }
                "swipe" -> {
                    val start = readPoint(json, "startX", "startY") ?: return
                    val end = readPoint(json, "endX", "endY") ?: return
                    val duration = json.optLong("duration", 300)
                    RemoteControlService.instance?.performSwipe(start.x, start.y, end.x, end.y, duration)
                }
                "key" -> {
                    RemoteControlService.instance?.performKey(json.optString("keyCode"))
                }
                "text" -> {
                    RemoteControlService.instance?.performText(json.optString("text"))
                }
                "gesture" -> {
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
                "touchStart" -> readPoint(json, "x", "y")?.let {
                    RemoteControlService.instance?.beginContinuousTouch(it.x, it.y)
                }
                "touchMove" -> readPoint(json, "x", "y")?.let {
                    RemoteControlService.instance?.moveContinuousTouch(it.x, it.y)
                }
                "touchEnd" -> readPoint(json, "x", "y")?.let {
                    RemoteControlService.instance?.endContinuousTouch(it.x, it.y)
                }
                "volume" -> adjustVolume(json.optString("direction"))
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
        audio.adjustSuggestedStreamVolume(adjustment, AudioManager.USE_DEFAULT_STREAM_TYPE, 0)
    }
}
