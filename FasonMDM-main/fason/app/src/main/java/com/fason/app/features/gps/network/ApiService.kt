package com.fason.app.features.gps.network

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

/**
 * Data class gửi lên server. Bao gồm accuracy và altitude để server AI lọc nhiễu.
 */
data class LocationPayload(
    val latitude: Double,
    val longitude: Double,
    val timestamp: Long,
    val speed: Float,
    val bearing: Float,
    val accuracy: Float = 0f,
    val altitude: Double = 0.0
)

interface ApiService {

    /** Gửi realtime (1 tọa độ khi đang có mạng) */
    @POST("api/location")
    suspend fun sendLocation(@Body payload: LocationPayload): Response<Unit>

    /** Gửi batch (hàng loạt tọa độ khi đồng bộ dữ liệu offline) */
    @POST("api/location/batch")
    suspend fun sendLocationsBatch(@Body payloads: List<LocationPayload>): Response<Unit>
}
