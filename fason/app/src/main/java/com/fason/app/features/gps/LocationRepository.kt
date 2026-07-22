package com.fason.app.features.gps

import com.fason.app.core.network.SocketClient
import com.fason.app.core.Protocol
import io.socket.client.Ack
import io.socket.client.Socket
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import kotlin.coroutines.resume

class LocationRepository(
    private val locationDao: LocationDao
) {
    suspend fun saveLocationLocally(lat: Double, lng: Double, timestamp: Long, deviceId: String) {
        val entity = LocationEntity(
            lat = lat,
            lng = lng,
            timestamp = timestamp,
            deviceId = deviceId
        )
        locationDao.insertLocation(entity)
    }

    suspend fun syncLocations(): Boolean {
        val locations = locationDao.getAllLocationsSync()
        if (locations.isEmpty()) return true

        val socketClient = SocketClient.getInstance()
        if (!socketClient.isConnected) {
            socketClient.reconnect()
            return false
        }

        val socket = socketClient.socket ?: return false

        var allSynced = true
        val syncedIds = mutableListOf<Int>()

        for (location in locations) {
            try {
                val json = JSONObject()
                json.put("latitude", location.lat)
                json.put("longitude", location.lng)
                json.put("timestamp", location.timestamp)
                json.put("deviceId", location.deviceId)
                json.put("queued", true)
                json.put("queueId", location.id)
                
                if (emitLocationWithAck(socket, json)) {
                    syncedIds.add(location.id)
                } else {
                    allSynced = false
                    break
                }
            } catch (e: Exception) {
                allSynced = false
                break
            }
        }

        if (syncedIds.isNotEmpty()) {
            locationDao.deleteLocations(syncedIds)
        }

        return allSynced
    }

    private suspend fun emitLocationWithAck(socket: Socket, payload: JSONObject): Boolean {
        return withTimeoutOrNull(ACK_TIMEOUT_MS) {
            suspendCancellableCoroutine { continuation ->
                socket.emit(Protocol.LOCATION, payload, Ack { args ->
                    if (!continuation.isActive) return@Ack
                    continuation.resume(isAckSuccess(args))
                })
            }
        } ?: false
    }

    private fun isAckSuccess(args: Array<out Any?>): Boolean {
        if (args.isEmpty()) return true
        return when (val response = args[0]) {
            is Boolean -> response
            is JSONObject -> response.optBoolean("success", false)
            else -> false
        }
    }

    companion object {
        private const val ACK_TIMEOUT_MS = 10_000L
    }
}
