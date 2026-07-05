package com.fason.app.features.gps.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface LocationDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(location: LocationEntity)

    @Query("SELECT * FROM pending_locations ORDER BY timestamp ASC")
    suspend fun getAllPending(): List<LocationEntity>

    @Query("DELETE FROM pending_locations WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query("DELETE FROM pending_locations")
    suspend fun deleteAll()

    @Query("SELECT COUNT(*) FROM pending_locations")
    suspend fun count(): Int
}
