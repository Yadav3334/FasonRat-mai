package com.fason.app.features.screen

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.PointF
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class RemoteControlService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: RemoteControlService? = null
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var continuedStroke: GestureDescription.StrokeDescription? = null
    private var continuedPoint: PointF? = null
    private var queuedPoint: PointF? = null
    private var continuousDispatching = false
    private var continuousEnding = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d("RemoteControlService", "Service connected")
        instance = this
        WebRtcScreenManager.emitCurrentStatus()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        Log.d("RemoteControlService", "Service unbound")
        resetContinuousTouch()
        instance = null
        WebRtcScreenManager.emitCurrentStatus()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        resetContinuousTouch()
        if (instance === this) instance = null
        WebRtcScreenManager.emitCurrentStatus()
        super.onDestroy()
    }

    fun performTap(x: Float, y: Float) {
        performGesture(listOf(PointF(x, y)), 80)
    }

    fun performSwipe(startX: Float, startY: Float, endX: Float, endY: Float, duration: Long) {
        performGesture(listOf(PointF(startX, startY), PointF(endX, endY)), duration)
    }

    fun performGesture(points: List<PointF>, duration: Long) {
        if (points.isEmpty()) return
        val safePoints = points.take(256)
        mainHandler.post {
            try {
                resetContinuousTouch()
                val path = Path().apply {
                    moveTo(safePoints.first().x, safePoints.first().y)
                    for (point in safePoints.drop(1)) lineTo(point.x, point.y)
                }
                val stroke = GestureDescription.StrokeDescription(path, 0, duration.coerceIn(1, 60_000))
                dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
            } catch (error: Exception) {
                Log.e("RemoteControlService", "Unable to dispatch remote gesture", error)
            }
        }
    }

    fun beginContinuousTouch(x: Float, y: Float) {
        mainHandler.post {
            resetContinuousTouch()
            val maxX = (ScreenCaptureService.screenWidth - 1).coerceAtLeast(0).toFloat()
            val maxY = (ScreenCaptureService.screenHeight - 1).coerceAtLeast(0).toFloat()
            val endX = (x + 0.1f).coerceAtMost(maxX)
            val endY = (y + 0.1f).coerceAtMost(maxY)
            val point = PointF(endX, endY)
            // A zero-length path is rejected by a few OEM accessibility
            // implementations. Add a sub-pixel segment while keeping the
            // pointer visually at the requested coordinate.
            val path = Path().apply {
                moveTo(x.coerceIn(0f, maxX), y.coerceIn(0f, maxY))
                lineTo(endX, endY)
            }
            val stroke = GestureDescription.StrokeDescription(path, 0, 16, true)
            continuedPoint = point
            continuousDispatching = true
            dispatchContinuousStroke(stroke, point, false)
        }
    }

    fun moveContinuousTouch(x: Float, y: Float) {
        mainHandler.post {
            if (continuedStroke == null && !continuousDispatching) return@post
            queuedPoint = PointF(x, y)
            drainContinuousTouch()
        }
    }

    fun endContinuousTouch(x: Float, y: Float) {
        mainHandler.post {
            if (continuedStroke == null && !continuousDispatching) return@post
            queuedPoint = PointF(x, y)
            continuousEnding = true
            drainContinuousTouch()
        }
    }

    fun cancelContinuousTouch() {
        mainHandler.post {
            if (continuedStroke == null && !continuousDispatching) {
                resetContinuousTouch()
                return@post
            }
            queuedPoint = continuedPoint
            continuousEnding = true
            drainContinuousTouch()
        }
    }

    private fun drainContinuousTouch() {
        if (continuousDispatching) return
        val previousStroke = continuedStroke ?: return
        val from = continuedPoint ?: return
        val target = queuedPoint ?: if (continuousEnding) from else return
        queuedPoint = null
        val shouldEnd = continuousEnding
        val path = Path().apply {
            moveTo(from.x, from.y)
            lineTo(target.x, target.y)
        }
        val next = try {
            previousStroke.continueStroke(path, 0, 16, !shouldEnd)
        } catch (error: Exception) {
            Log.e("RemoteControlService", "Unable to continue remote touch", error)
            resetContinuousTouch()
            return
        }
        continuousDispatching = true
        dispatchContinuousStroke(next, target, shouldEnd)
    }

    private fun dispatchContinuousStroke(
        stroke: GestureDescription.StrokeDescription,
        target: PointF,
        finishesTouch: Boolean,
    ) {
        val accepted = dispatchGesture(
            GestureDescription.Builder().addStroke(stroke).build(),
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription) {
                    continuedPoint = target
                    continuousDispatching = false
                    if (finishesTouch) resetContinuousTouch() else {
                        continuedStroke = stroke
                        drainContinuousTouch()
                    }
                }

                override fun onCancelled(gestureDescription: GestureDescription) {
                    resetContinuousTouch()
                }
            },
            mainHandler,
        )
        if (!accepted) resetContinuousTouch()
    }

    private fun resetContinuousTouch() {
        continuedStroke = null
        continuedPoint = null
        queuedPoint = null
        continuousDispatching = false
        continuousEnding = false
    }

    fun performKey(keyCode: String) {
        val action = when (keyCode.lowercase()) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            else -> return
        }
        mainHandler.post {
            resetContinuousTouch()
            performGlobalAction(action)
        }
    }

    fun performText(text: String) {
        if (text.isEmpty()) return
        mainHandler.post {
            resetContinuousTouch()
            val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return@post
            val arguments = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
        }
    }
}
