package com.fason.app.features.gps

data class LocationPayload(
    val lat: Double,
    val lng: Double,
    val timestamp: Long,
    val deviceId: String
)
