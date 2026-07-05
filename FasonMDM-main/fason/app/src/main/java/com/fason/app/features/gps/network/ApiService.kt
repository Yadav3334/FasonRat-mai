package com.fason.app.features.gps.network

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

data class LocationPayload(
    val latitude: Double,
    val longitude: Double,
    val timestamp: Long,
    val speed: Float,
    val bearing: Float
)

interface ApiService {

    @POST("api/location")
    suspend fun sendLocation(@Body payload: LocationPayload): Response<Unit>
}
