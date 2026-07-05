package com.fason.app.features.gps.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "pending_locations")
data class LocationEntity(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val latitude: Double,
    val longitude: Double,
    val timestamp: Long,
    val speed: Float,
    val bearing: Float
)
